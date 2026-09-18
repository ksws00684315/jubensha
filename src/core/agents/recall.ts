import { db } from "@/lib/db";
import { embedTexts, embeddingSpaceId, resolveBinding } from "@/core/llm/client";
import type { EngineEvent } from "@/core/engine/types";
import { visibleTo } from "@/core/engine/state";
import { buildPublicEvidenceRegistry } from "./evidence";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

/**
 * ★ 向量检索记忆层 ★（SillyTavern Chat Vectorization / AI Dungeon Memory Bank 思路）
 * 公开发言在落库时异步写入 embedding（仅当设置页绑定 embedding 槽位；未绑定则整层静默关闭）。
 * 生成台词/决策时，用最近几条发言作 query 检索"已被滚动摘要压缩掉的旧发言"，
 * 把最相关的几条以【旧事重提】注回上下文——摘要管"大意"，检索管"原话"，两层互补。
 */

/** 相关度低于该阈值的旧事不注入。
 * 用本机 Ollama bge-m3 对真实对局标定：无关 query 的噪声地板约 0.34（同域中文基线就高），
 * 语义相关命中约 0.55-1.0。0.45 恰在两者之间；换向量模型后建议重新标定。 */
const SIMILARITY_THRESHOLD = 0.45;
const TOP_K = 3;

export interface RecallLine {
  label: string;
  text: string;
  sourceSeq?: string;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 检索与 query 语义最相关的"摘要锚点之前"的公开发言，并对公开线索做精确回查。
 * 无滚动记忆（全量日志本就在上下文里）或 embedding 未绑定时仍会返回精确命中的公开线索。
 */
export async function recallRelevantStatements(args: {
  gameId: string;
  events: EngineEvent[];
  seatIndex: number | null;
  anchorSeq: string;
  query: string;
  script?: ScriptDocV2;
}): Promise<RecallLine[]> {
  const { gameId, events, seatIndex, anchorSeq, query, script } = args;
  if (!anchorSeq || !query.trim()) return [];
  const anchor = BigInt(anchorSeq);
  const directClueLines: RecallLine[] = [];
  if (script) {
    for (const record of buildPublicEvidenceRegistry(script, { clueStates: Object.fromEntries(events.filter((e) => e.type === "clue" && e.visibility === "public" && typeof e.content.clueId === "string").map((e) => [String(e.content.clueId), { discoveredBy: e.fromSeat, isPublic: true }])) }, events).filter((item) => item.kind === "clue")) {
      const sourceSeq = record.sourceSeqs.find((seq) => BigInt(seq) <= anchor);
      const terms = [record.title, ...record.text.split(/[，。；：、\s]+/).filter((term) => term.length >= 4)];
      if (sourceSeq && terms.some((term) => query.includes(term))) {
        directClueLines.push({ label: `${record.title}（公开线索）`, text: record.text, sourceSeq });
      }
    }
  }
  const candidates = events.filter(
    (e) => e.type === "speech" && BigInt(e.seq) <= anchor && visibleTo(e, seatIndex) && typeof e.content.text === "string" && e.content.text.trim()
  );
  if (!candidates.length) return directClueLines;

  const binding = await resolveBinding("embedding").catch(() => null);
  if (!binding) return directClueLines;
  const spaceId = embeddingSpaceId(binding);
  const rows = await db.eventVector.findMany({ where: { gameId, seq: { lte: anchor }, spaceId } });
  const vectorBySeq = new Map<string, number[]>();
  for (const row of rows) {
    const v = row.vector as unknown;
    if (Array.isArray(v) && row.dimension === v.length && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
      vectorBySeq.set(row.seq.toString(), v as number[]);
    }
  }
  const withVectors = candidates.filter((e) => vectorBySeq.has(e.seq));
  if (!withVectors.length) return directClueLines;

  const [queryVector] = (await embedTexts([query.slice(0, 512)])) ?? [];
  if (!queryVector) return directClueLines;

  const scored = withVectors
    .filter((e) => (vectorBySeq.get(e.seq)?.length ?? 0) === queryVector.length)
    .map((e) => ({ e, score: cosine(queryVector, vectorBySeq.get(e.seq) ?? []) }))
    .filter((s) => s.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const lines: RecallLine[] = scored.map(({ e }) => {
    const who = e.fromSeat === null ? "主持人" : `${e.content.speakerName ?? `玩家${e.fromSeat + 1}`}`;
    const round = e.round ? `第${e.round}轮` : "";
    return {
      label: `${who}${round ? `（${round}）` : ""}`,
      text: String(e.content.text),
      sourceSeq: e.seq,
    };
  });

  return [...directClueLines, ...lines];
}
