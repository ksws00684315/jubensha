import { db } from "@/lib/db";
import { embedTexts } from "@/core/llm/client";
import type { EngineEvent, GameState } from "@/core/engine/types";
import { visibleTo } from "@/core/engine/state";

/**
 * ★ 向量检索记忆层 ★（SillyTavern Chat Vectorization / AI Dungeon Memory Bank 思路）
 * 公开发言在落库时异步写入 embedding（仅当设置页绑定 embedding 槽位；未绑定则整层静默关闭）。
 * 生成台词/决策时，用最近几条发言作 query 检索"已被滚动摘要压缩掉的旧发言"，
 * 把最相关的几条以【旧事重提】注回上下文——摘要管"大意"，检索管"原话"，两层互补。
 */

/** 相关度低于该阈值的旧事不注入（经验值，相似语料下防噪声） */
const SIMILARITY_THRESHOLD = 0.3;
const TOP_K = 3;

export interface RecallLine {
  label: string;
  text: string;
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
 * 检索与 query 语义最相关的"摘要锚点之前"的公开发言。
 * 无滚动记忆（全量日志本就在上下文里）或 embedding 未绑定时返回空。
 */
export async function recallRelevantStatements(args: {
  gameId: string;
  events: EngineEvent[];
  seatIndex: number | null;
  anchorSeq: string;
  query: string;
}): Promise<RecallLine[]> {
  const { gameId, events, seatIndex, anchorSeq, query } = args;
  if (!anchorSeq || !query.trim()) return [];
  const anchor = BigInt(anchorSeq);
  const candidates = events.filter(
    (e) => e.type === "speech" && BigInt(e.seq) <= anchor && visibleTo(e, seatIndex) && typeof e.content.text === "string" && e.content.text.trim()
  );
  if (!candidates.length) return [];

  const rows = await db.eventVector.findMany({ where: { gameId, seq: { lte: anchor } } });
  const vectorBySeq = new Map<string, number[]>();
  for (const row of rows) {
    const v = row.vector as unknown;
    if (Array.isArray(v)) vectorBySeq.set(row.seq.toString(), v as number[]);
  }
  const withVectors = candidates.filter((e) => vectorBySeq.has(e.seq));
  if (!withVectors.length) return [];

  const [queryVector] = (await embedTexts([query.slice(0, 512)])) ?? [];
  if (!queryVector) return [];

  const scored = withVectors
    .map((e) => ({ e, score: cosine(queryVector, vectorBySeq.get(e.seq) ?? []) }))
    .filter((s) => s.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  return scored.map(({ e }) => {
    const who = e.fromSeat === null ? "主持人" : `${e.content.speakerName ?? `玩家${e.fromSeat + 1}`}`;
    const round = e.round ? `第${e.round}轮` : "";
    return {
      label: `${who}${round ? `（${round}）` : ""}`,
      text: String(e.content.text).slice(0, 140),
    };
  });
}
