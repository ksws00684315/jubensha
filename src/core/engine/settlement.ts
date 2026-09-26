import { resolveFinaleOutcome } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

/** 侦探（非凶手）座位的结算卡：沿用"投对 70 + 有效公开证据 10/张（封顶 30）"的原始公式。 */
export type DetectiveSettlement = {
  outcome: "caught" | "escaped";
  voteCorrect: boolean;
  evidenceCount: number;
  score: number;
  myVoteTarget: number | null;
};

/** 凶手座位的专属结算卡：不给侦探式分数，改给身份结局（是否被识破、几票指认、结局标题与判词）。 */
export type CulpritSettlement = {
  outcome: "exposed" | "escaped";
  title: string;
  verdict: string;
  votesAgainst: number;
};

export type SeatSettlementView = {
  settlement: DetectiveSettlement | null;
  culpritSettlement: CulpritSettlement | null;
};

type VoteResultView = { counts: Record<string, number>; culpritSeat: number; caught: boolean; tiedSeats?: number[] } | null;

/**
 * 结算投影（纯函数，供 GET /api/games/[id] 与单测共用）：
 * - choice 模式不指凶，两类结算都为 null（沿用原条件）；
 * - 凶手座位（角色 id 命中 truth.culpritId）返回 culpritSettlement、settlement 恒 null，避免 UI 出现两张语义混乱的卡；
 * - 其余座位返回 detective settlement，字段与历史行为逐字段一致；
 * - 凶手未入座（culpritSeat < 0）时场上没有凶手座位，全员走侦探分支。
 */
export function buildSeatSettlement(args: {
  doc: ScriptDocV2;
  mySeat: number | null;
  myCharacterId: string | null;
  voteResult: VoteResultView;
  publicEvidenceIds: ReadonlySet<string>;
  myVote: { target: number; evidenceIds?: string[] } | null | undefined;
}): SeatSettlementView {
  const { doc, mySeat, myCharacterId, voteResult, publicEvidenceIds, myVote } = args;
  if (doc.flow.voteMode === "choice" || !voteResult || mySeat === null) {
    return { settlement: null, culpritSettlement: null };
  }
  if (myCharacterId && myCharacterId === doc.truth.culpritId) {
    const outcome = resolveFinaleOutcome(doc, voteResult);
    return {
      settlement: null,
      culpritSettlement: {
        outcome: voteResult.caught ? "exposed" : "escaped",
        title: outcome.title,
        verdict: outcome.verdict,
        votesAgainst: voteResult.counts[String(mySeat)] ?? 0,
      },
    };
  }
  const voteCorrect = voteResult.culpritSeat >= 0 && myVote?.target === voteResult.culpritSeat;
  const evidenceCount = (myVote?.evidenceIds ?? []).filter((id) => publicEvidenceIds.has(id)).length;
  return {
    settlement: {
      outcome: voteResult.caught ? "caught" : "escaped",
      voteCorrect,
      evidenceCount,
      score: (voteCorrect ? 70 : 0) + Math.min(30, evidenceCount * 10),
      myVoteTarget: myVote?.target ?? null,
    },
    culpritSettlement: null,
  };
}
