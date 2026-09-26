/**
 * Jev（TypeSafe AI "System One" 决策模型）客户端。
 *
 * 与聊天路径完全解耦：/v1/systemone 不是 OpenAI 兼容协议（请求体是 state + questions，
 * 响应是带概率的 choice/noul/score），所以不走 AI SDK，仿 embedTexts 直接 fetch。
 * 端点由调用方注入——一期评测脚本从环境变量组装，二期由 decision 槽位绑定组装——
 * 本模块不 import db、不读任何全局配置，以保证「未绑定即完全不启用」的可选性。
 */

/** Jev 1.13：输入计费、输出免费，非聊天模型 */
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;
/** 429/5xx/网络错误的退避间隔；决策模型走在线路径，宁可快速失败也不拖长回合 */
const DEFAULT_RETRY_DELAYS_MS = [400, 1200];
/** Jev 1.13：输入 $0.042/1M tokens（$42/1B）；输出免费 */
export const JEV_INPUT_COST_PER_TOKEN_USD = 42 / 1_000_000_000;
/** 官方声明的 Choice 原语候选上限 */
export const MAX_CHOICE_OPTIONS = 255;

export interface JevEndpoint {
  baseUrl: string;
  apiKey: string;
  modelId?: string;
}

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria?: Record<string, string> }
  | { type: "score"; instructions: string; criteria?: Record<string, string> };

export interface JevRequest {
  /** 被评估的内容：声明式结构化状态，不是自由文本 prompt */
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, JevQuestion>;
  model?: string;
}

export interface JevCallOptions {
  timeoutMs?: number;
  /** 仅作测试缝；线上用默认值 */
  retryDelaysMs?: number[];
  signal?: AbortSignal;
}

export type JevAnswer =
  | {
      id: string;
      type: "choice";
      /** 命中的 criteria 键；rejected 时为 null */
      key: string | null;
      /** 该键的概率，供弃权阈值判定 */
      probability: number | null;
      confidence: number | null;
      /** 响应缺 choice 或不在请求的 criteria 键集内：调用方据此回落现网路径 */
      rejected: boolean;
    }
  | { id: string; type: "noul"; probability: number | null; confidence: number | null }
  | { id: string; type: "score"; score: number | null; legend: Record<string, string>; confidence: number | null };

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

/** 传输层/协议层失败（区别于 answered-but-rejected 的业务层失败） */
export class JevError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

/** 允许管理员把 baseUrl 填成 API 根或完整端点，不因此产生 /v1/v1 双段 */
function systemOneUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1\/systemone$/i, "");
  return `${trimmed}/v1/systemone`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface RawAnswer {
  choice?: unknown;
  probabilities?: unknown;
  confidence?: unknown;
  noul?: unknown;
  score?: unknown;
  legend?: unknown;
}

function parseAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  const a = (raw ?? {}) as RawAnswer;
  const confidence = num(a.confidence);
  if (question.type === "noul") return { id, type: "noul", probability: num(a.noul), confidence };
  if (question.type === "score") {
    const legend = a.legend && typeof a.legend === "object" ? (a.legend as Record<string, string>) : {};
    return { id, type: "score", score: num(a.score), legend, confidence };
  }
  const probabilities = (a.probabilities && typeof a.probabilities === "object" ? a.probabilities : {}) as Record<string, number>;
  const choice = typeof a.choice === "string" ? a.choice : null;
  const key = choice !== null && Object.prototype.hasOwnProperty.call(question.criteria, choice) ? choice : null;
  return { id, type: "choice", key, probability: key === null ? null : num(probabilities[key]), confidence, rejected: key === null };
}

function validate(endpoint: JevEndpoint, req: JevRequest): void {
  if (!endpoint.apiKey?.trim()) throw new JevError("Jev 未配置 API key：请在「设置 → AI 接入」绑定决策模型，或提供 JEV_API_KEY");
  const ids = Object.keys(req.questions ?? {});
  if (!ids.length) throw new JevError("Jev 调用必须至少带一个 question");
  for (const id of ids) {
    const q = req.questions[id];
    if (q.type !== "choice") continue;
    const n = Object.keys(q.criteria ?? {}).length;
    if (!n) throw new JevError(`question "${id}" 为 choice 但 criteria 为空`);
    if (n > MAX_CHOICE_OPTIONS) throw new JevError(`question "${id}" 候选 ${n} 项，超出 Jev choice 上限 ${MAX_CHOICE_OPTIONS}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** 一次请求可批量带多个 questions：同批决策共享 state 的输入计费只算一次。 */
export async function askSystemOne(endpoint: JevEndpoint, req: JevRequest, opts: JevCallOptions = {}): Promise<JevResult> {
  validate(endpoint, req);
  const url = systemOneUrl(endpoint.baseUrl);
  const body = JSON.stringify({ state: req.state, model: req.model ?? endpoint.modelId ?? DEFAULT_MODEL, questions: req.questions });
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  // timeoutMs 是整次逻辑调用的总预算；所有重试和退避共用同一截止信号。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  let lastError = new JevError("Jev 调用失败");

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.apiKey.trim()}`, "Content-Type": "application/json" },
        body,
        signal,
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as {
          answers?: Record<string, unknown>;
          usage?: { input_tokens?: number; output_tokens?: number };
        } | null;
        const answers = json?.answers;
        if (!answers || typeof answers !== "object") throw new JevError("Jev 响应缺少 answers 字段");
        return {
          answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, parseAnswer(id, q, answers[id])])),
          usage: { inputTokens: num(json?.usage?.input_tokens) ?? 0, outputTokens: num(json?.usage?.output_tokens) ?? 0 },
          latencyMs: Date.now() - started,
        };
      }
      const text = (await res.text().catch(() => "")).slice(0, 200);
      lastError = new JevError(`Jev 调用失败：HTTP ${res.status} ${text}`, res.status);
      // 4xx 里只有 429 值得重试；其余是请求本身不被接受，退避后再打也是浪费
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      if (opts.signal?.aborted) throw new JevError("Jev 调用已取消");
      if (timeoutSignal.aborted) {
        lastError = new JevError(`Jev 调用超时（${timeoutMs}ms）`);
        break;
      }
      lastError = err instanceof JevError ? err : new JevError(`Jev 调用失败：${err instanceof Error ? err.message : String(err)}`);
      if (!(lastError.status === undefined || lastError.status >= 500 || lastError.status === 429)) break;
    }
    if (attempt < delays.length) {
      await sleep(delays[attempt], signal);
      if (opts.signal?.aborted) throw new JevError("Jev 调用已取消");
      if (timeoutSignal.aborted) {
        lastError = new JevError(`Jev 调用超时（${timeoutMs}ms）`);
        break;
      }
    }
  }
  throw lastError;
}
