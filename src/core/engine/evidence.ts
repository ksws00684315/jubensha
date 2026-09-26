import type { GameEngine } from "./engine";
import type { ClueRuntime } from "./types";

/** 公开线索证据的唯一定义点：投票引用与当众提问引用共用，禁止再散落副本。 */

type ClueIdList = readonly { id: string }[];
type ClueStateMap = Record<string, ClueRuntime | undefined>;

export function publicClueIdSet(clues: ClueIdList, clueStates: ClueStateMap): Set<string> {
  return new Set(clues.filter((clue) => clueStates[clue.id]?.isPublic).map((clue) => clue.id));
}

/** 去重并过滤出当前已公开的线索 id；保留首次出现顺序。 */
export function legalPublicEvidenceIds(e: Pick<GameEngine, "script" | "state">, ids: readonly string[] | undefined): string[] {
  const publicIds = publicClueIdSet(e.script.clues, e.state.clueStates);
  return [...new Set(ids ?? [])].filter((id) => publicIds.has(id));
}

/** 传入 id 中不属于当前公开线索的部分（去重，保留出现顺序）。 */
export function illegalPublicEvidenceIds(clues: ClueIdList, clueStates: ClueStateMap, ids: readonly string[] | undefined): string[] {
  const publicIds = publicClueIdSet(clues, clueStates);
  return [...new Set(ids ?? [])].filter((id) => !publicIds.has(id));
}

/**
 * 投票证据校验：返回错误文案，null 表示通过。
 * - 附了 id 且存在任何非法/未公开项 → 逐个列出（含部分合法的情况：宁拒绝不放行，
 *   避免调用方拼错一个 id 后被静默过滤却毫无察觉）；
 * - 场上存在公开证据但未附任何 id → 指明 evidenceIds 字段；
 * - 场上无公开证据时不附 id 仍然放行（沿用历史行为）。
 */
export function validateVoteEvidence(clues: ClueIdList, clueStates: ClueStateMap, provided: readonly string[] | undefined): string | null {
  const providedList = [...new Set(provided ?? [])];
  if (providedList.length) {
    const illegal = illegalPublicEvidenceIds(clues, clueStates, providedList);
    if (illegal.length) return `证据含非法或未公开的线索卡：${illegal.join("、")}`;
    return null;
  }
  if (publicClueIdSet(clues, clueStates).size) return "投票需引用公开证据：请在 evidenceIds 中附至少一张公开线索卡";
  return null;
}
