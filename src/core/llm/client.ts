import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText, type LanguageModel } from "ai";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { candidateModelListUrls, normalizeProviderBaseUrl } from "./provider-url";
import { emptyCompletionError, isRetryableLlmError, resolveMaxOutputTokens } from "./output-tokens";
import type { ChatMessage, ChatOptions, ChatResult, Purpose, ResolvedBinding } from "./types";

export type { ChatMessage, ChatOptions, ChatResult, Purpose } from "./types";
export { extractJson } from "./json";

/** 读取某用途槽位的绑定（含 fallback 链），运行时解析 apiKey */
export async function resolveBinding(slot: Purpose): Promise<ResolvedBinding> {
  let current: string = slot;
  for (let i = 0; i < 3; i++) {
    const binding = await db.modelBinding.findUnique({ where: { slot: current }, include: { provider: true } });
    if (binding) {
      if (!binding.provider.enabled) {
        if (binding.fallbackSlot) {
          current = binding.fallbackSlot;
          continue;
        }
        throw new Error(`绑定槽位 "${slot}" 的 Provider「${binding.provider.name}」已被禁用，请到设置页检查`);
      }
      return {
        providerId: binding.providerId,
        providerName: binding.provider.name,
        protocol: binding.provider.protocol,
        baseUrl: binding.provider.baseUrl,
        apiKey: decryptSecret(binding.provider.apiKeyCipher),
        modelId: binding.modelId,
        temperature: binding.temperature ?? null,
        maxTokens: binding.maxTokens ?? null,
        fallbackSlot: binding.fallbackSlot ?? null,
      };
    }
    // 该槽位无绑定，沿 fallbackSlot 找
    throw new Error(`用途槽位 "${slot}" 尚未绑定模型，请到「设置 → AI 接入」完成配置`);
  }
  throw new Error(`槽位 "${slot}" 的 fallback 链解析失败`);
}

function toLanguageModel(b: ResolvedBinding, extraBody?: Record<string, unknown>): LanguageModel {
  const baseURL = normalizeProviderBaseUrl(b.baseUrl, b.protocol);
  if (b.protocol === "anthropic") {
    const p = createAnthropic({ apiKey: b.apiKey, baseURL: baseURL || undefined });
    return p(b.modelId);
  }
  const p = createOpenAICompatible({
    name: b.providerName,
    baseURL,
    apiKey: b.apiKey,
    ...(extraBody
      ? { transformRequestBody: (args: Record<string, any>) => ({ ...args, ...extraBody }) }
      : {}),
  });
  return p(b.modelId);
}

function normalizeUsage(usage: unknown): { prompt: number; completion: number; cached: number } {
  const u = usage as {
    inputTokens?: number;
    outputTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cachedTokens?: number };
    prompt_tokens_details?: { cached_tokens?: number; cache_hit_tokens?: number };
  } | undefined;
  const details = u?.inputTokenDetails;
  const raw = u?.prompt_tokens_details;
  return {
    prompt: u?.inputTokens ?? u?.promptTokens ?? 0,
    completion: u?.outputTokens ?? u?.completionTokens ?? 0,
    cached:
      u?.cachedInputTokens ??
      details?.cacheReadTokens ??
      details?.cachedTokens ??
      raw?.cached_tokens ??
      raw?.cache_hit_tokens ??
      0,
  };
}

async function logUsage(args: {
  b: ResolvedBinding;
  purpose: string;
  gameId?: string | null;
  prompt: number;
  completion: number;
  cached?: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}): Promise<void> {
  try {
    await db.usageLog.create({
      data: {
        providerId: args.b.providerId,
        providerName: args.b.providerName,
        modelId: args.b.modelId,
        purpose: args.purpose,
        gameId: args.gameId ?? null,
        promptTokens: args.prompt,
        completionTokens: args.completion,
        cachedTokens: args.cached ?? 0,
        totalTokens: args.prompt + args.completion,
        latencyMs: args.latencyMs,
        ok: args.ok,
        error: args.error?.slice(0, 500),
      },
    });
  } catch {
    // 记账失败不影响主流程
  }
}

const RETRY_DELAYS_MS = [800, 2000];
const REQUEST_TIMEOUT_MS = 180_000;

function isRetryable(err: unknown): boolean {
  return isRetryableLlmError(err);
}

/** 部分网关拒绝 system 角色，把系统提示并进第一条 user 的前缀（仍保持「稳定前缀 + 追加尾部」以便缓存）。 */
function toCompatibleMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  if (!system) return rest;
  const firstUser = rest.findIndex((m) => m.role === "user");
  if (firstUser >= 0) {
    rest[firstUser] = { role: "user", content: `${system}\n\n${rest[firstUser].content}` };
    return rest;
  }
  return [{ role: "user", content: system }, ...rest];
}

/** 单次绑定调用（不重试），返回 { text, usage } */
async function callOnce(
  b: ResolvedBinding,
  purpose: string,
  opts: ChatOptions
): Promise<{ text: string; prompt: number; completion: number; cached: number; latencyMs: number }> {
  const messages = toCompatibleMessages(opts.messages);
  const started = Date.now();
  const maxOutputTokens = resolveMaxOutputTokens(b.maxTokens, opts.maxTokens);

  const invoke = async (extra?: Record<string, unknown>) => {
    const result = await generateText({
      model: toLanguageModel(b, extra),
      messages,
      temperature: opts.temperature ?? b.temperature ?? 0.8,
      maxOutputTokens,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const usage = normalizeUsage(result.usage);
    const text = (result.text ?? "").trim();
    if (!text) {
      console.warn(
        `[llm] empty text purpose=${purpose} model=${b.modelId} completion=${usage.completion} maxOutput=${maxOutputTokens}`
      );
      throw emptyCompletionError(usage.completion);
    }
    return {
      text,
      prompt: usage.prompt,
      completion: usage.completion,
      cached: usage.cached,
      latencyMs: Date.now() - started,
    };
  };

  try {
    // 推理模型默认开思考会把输出额度吃光；多数网关会忽略未知字段。
    return await invoke({ thinking: { type: "disabled" } });
  } catch (err) {
    if (isRetryableLlmError(err) && /unknown|unrecognized|unexpected.?field|invalid/i.test(String(err))) {
      return await invoke();
    }
    throw err;
  }
}

/** 非流式对话：重试 + fallback + 用量记账 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  let binding: ResolvedBinding;
  try {
    binding = await resolveBinding(opts.purpose);
  } catch (err) {
    throw err;
  }

  const slotsToTry: ResolvedBinding[] = [binding];
  if (binding.fallbackSlot) {
    try {
      slotsToTry.push(await resolveBinding(binding.fallbackSlot as Purpose));
    } catch {
      // fallback 不可用就只用主绑定
    }
  }

  let lastErr: unknown = null;
  for (const b of slotsToTry) {
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const r = await callOnce(b, opts.purpose, opts);
        await logUsage({ b, purpose: opts.purpose, gameId: opts.gameId, ...r, ok: true });
        return {
          text: r.text,
          promptTokens: r.prompt,
          completionTokens: r.completion,
          providerName: b.providerName,
          modelId: b.modelId,
        };
      } catch (err) {
        lastErr = err;
        console.warn(`[llm] call failed purpose=${opts.purpose} model=${b.modelId}:`, err instanceof Error ? err.message : err);
        if (!isRetryable(err)) break;
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  // 记一条失败日志
  try {
    await logUsage({
      b: slotsToTry[0],
      purpose: opts.purpose,
      gameId: opts.gameId,
      prompt: 0,
      completion: 0,
      latencyMs: 0,
      ok: false,
      error: msg,
    });
  } catch {
    /* ignore */
  }
  throw new Error(`LLM 调用失败（${slotsToTry[0].providerName}/${slotsToTry[0].modelId}）: ${msg}`);
}

/** 流式对话：逐 token 产出文本；结束时记账。失败时抛出。 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string> {
  const b = await resolveBinding(opts.purpose);
  const model = toLanguageModel(b, { thinking: { type: "disabled" } });
  const messages = toCompatibleMessages(opts.messages);
  const started = Date.now();
  try {
    const result = streamText({
      model,
      messages,
      temperature: opts.temperature ?? b.temperature ?? 0.8,
      maxOutputTokens: resolveMaxOutputTokens(b.maxTokens, opts.maxTokens),
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    for await (const chunk of result.textStream) {
      yield chunk;
    }
    const usage = normalizeUsage(await result.usage);
    await logUsage({
      b,
      purpose: opts.purpose,
      gameId: opts.gameId,
      ...usage,
      latencyMs: Date.now() - started,
      ok: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logUsage({
      b,
      purpose: opts.purpose,
      gameId: opts.gameId,
      prompt: 0,
      completion: 0,
      latencyMs: Date.now() - started,
      ok: false,
      error: msg,
    });
    throw new Error(`LLM 流式调用失败（${b.providerName}/${b.modelId}）: ${msg}`);
  }
}

function modelIdsFrom(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: Array<{ id?: string }> }).data;
  if (!Array.isArray(data)) return [];
  return data.map((m) => m.id ?? "").filter(Boolean);
}

async function fetchJson(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** 测试连通性：同源沿路径向上探测 /models，不按厂商写死地址。 */
export async function testProviderConnection(input: {
  protocol: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const headers = {
    Authorization: `Bearer ${input.apiKey}`,
    "api-key": input.apiKey,
    "x-api-key": input.apiKey,
    "anthropic-version": "2023-06-01",
  };
  const urls = candidateModelListUrls(normalizeProviderBaseUrl(input.baseUrl, input.protocol));
  const errors: string[] = [];
  try {
    for (const url of urls) {
      const r = await fetchJson(url, headers);
      if (r.ok) return { ok: true, models: modelIdsFrom(r.json) };
      if (r.status !== 404) errors.push(`${r.status} ${url.replace(/https?:\/\/[^/]+/, "")}`);
    }
    const detail = errors.slice(0, 3).join("; ") || "all 404";
    return { ok: false, error: `未找到模型列表（${detail}）。请把 Base URL 填成 API 根地址，一般以 /v1 结尾。` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
