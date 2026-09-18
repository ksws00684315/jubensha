import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

/**
 * TTS 接口层：以 "tts" 槽位的 ModelBinding 为配置来源（OpenAI 兼容 /audio/speech 协议）。
 * 合成结果缓存到 .data/audio/ 并落库去重，同一文本不重复付费。
 */

const AUDIO_DIR = path.join(process.cwd(), ".data", "audio");
/** 缓存上限（条）：超限时按最旧创建时间成批清理，防止 .data/audio 无界增长。 */
const TTS_CACHE_MAX = 500;
const TTS_CACHE_TRIM_BATCH = 20;

export interface TtsResult {
  filePath: string;
  hash: string;
  cached: boolean;
}

function ttsHash(text: string, providerId: string, model: string, voice: string): string {
  return crypto.createHash("sha256").update(`${providerId}|${model}|${voice}|${text}`).digest("hex").slice(0, 32);
}

export async function synthesize(text: string, opts: { voice?: string } = {}): Promise<TtsResult> {
  const binding = await db.modelBinding.findUnique({ where: { slot: "tts" }, include: { provider: true } });
  if (!binding || !binding.provider.enabled) {
    throw new Error("TTS 尚未绑定或 Provider 被禁用（设置 → AI 接入 → tts 槽位）");
  }
  const apiKey = decryptSecret(binding.provider.apiKeyCipher);
  const voice = opts.voice ?? process.env.TTS_VOICE ?? "alloy";
  const hash = ttsHash(text, binding.providerId, binding.modelId, voice);

  const cached = await db.ttsCache.findUnique({ where: { hash } });
  if (cached) {
    try {
      await fs.access(cached.filePath);
      return { filePath: cached.filePath, hash, cached: true };
    } catch {
      // 缓存文件丢失，重新生成
    }
  }

  const base = binding.provider.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: binding.modelId, input: text, voice, response_format: "mp3" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`TTS 合成失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const filePath = path.join(AUDIO_DIR, `${hash}.mp3`);
  await fs.writeFile(filePath, buf);
  await db.ttsCache.upsert({
    where: { hash },
    create: { hash, provider: binding.provider.name, voice, filePath },
    update: { filePath },
  });
  await trimTtsCache();
  return { filePath, hash, cached: false };
}

/** 惰性修剪：每次新写入后顺带清理溢出批次；失败只记日志，不影响合成结果。 */
async function trimTtsCache(): Promise<void> {
  try {
    const overflow = await db.ttsCache.findMany({
      orderBy: { createdAt: "asc" },
      skip: TTS_CACHE_MAX,
      take: TTS_CACHE_TRIM_BATCH,
      select: { id: true, filePath: true },
    });
    if (!overflow.length) return;
    await db.ttsCache.deleteMany({ where: { id: { in: overflow.map((o) => o.id) } } });
    for (const o of overflow) await fs.unlink(o.filePath).catch(() => null);
  } catch (err) {
    console.error(`[tts] 缓存修剪失败（不影响本次合成）：${String(err)}`);
  }
}
