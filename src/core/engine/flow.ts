import type { GameState, Phase } from "./types";
import { activeSeats } from "./state";
import type { ActV2, SkillV2 } from "@/core/script/v2/schema";

export const QUESTIONS_PER_PLAYER = 3;

export function nextAfterDiscussion(round: number, searchRounds: number, discussionRounds: number): Phase {
  if (round < searchRounds) return "SEARCH";
  if (round < discussionRounds) return "DISCUSSION";
  return "VOTE";
}

export function nextAfterSearch(round: number, searchRounds: number, discussionRounds: number): Phase {
  if (round < discussionRounds) return "DISCUSSION";
  if (round < searchRounds) return "SEARCH";
  return "VOTE";
}

export function ensureDiscussionState(state: GameState): void {
  state.questionsLeft ??= {};
  state.pendingAnswer ??= null;
  for (const seat of activeSeats(state)) {
    if (state.questionsLeft[String(seat)] === undefined) state.questionsLeft[String(seat)] = QUESTIONS_PER_PLAYER;
  }
}

/** 讨论阶段提问前置校验。返回错误文案，通过则为 null。 */
export function validateDiscussionAsk(state: GameState, fromSeat: number, toSeat: number): string | null {
  ensureDiscussionState(state);
  if (state.phase !== "DISCUSSION") return "当前不在讨论环节";
  if (state.pendingAnswer) return "请先等待当前提问被回答";
  if (state.turnSeat !== fromSeat) return "还没轮到你提问";
  if (toSeat === fromSeat) return "不能向自己提问";
  if (!activeSeats(state).includes(toSeat)) return "提问对象不合法";
  const left = state.questionsLeft[String(fromSeat)] ?? 0;
  if (left <= 0) return "提问次数已用完";
  return null;
}

/**
 * 线索转交前置校验（讨论阶段，把未公开的持有线索面交给其他座位）。
 * 返回错误文案，通过则为 null。持有权唯一事实源是 heldClues。
 */
export function validateTransfer(
  script: { flow: { allowClueTransfer: boolean }; clues: ReadonlyArray<{ id: string }> },
  state: Pick<GameState, "phase" | "seats" | "heldClues" | "clueStates">,
  fromSeat: number,
  clueId: string,
  toSeat: number
): string | null {
  if (state.phase !== "DISCUSSION") return "当前不在讨论环节";
  if (script.flow.allowClueTransfer !== true) return "本局不支持线索转交";
  if (toSeat === fromSeat) return "不能转交给自己";
  if (!activeSeats(state).includes(toSeat)) return "转交对象不合法";
  if (!(state.heldClues[fromSeat] ?? []).includes(clueId)) return "你没有这张线索卡";
  if (state.clueStates[clueId]?.isPublic === true) return "公开线索无需转交";
  return null;
}

/** 技能发动前置校验（v1 仅 verify/质询）。返回错误文案，通过则为 null。 */
export function validateUseSkill(
  script: {
    flow: { actionPointsPerRound: number };
    characters: ReadonlyArray<{ id: string; privateCard: { skills: ReadonlyArray<SkillV2> } }>;
  },
  state: Pick<GameState, "phase" | "seats" | "actionPoints" | "usedSkills">,
  fromSeat: number,
  skillId: string,
  toSeat: number | undefined,
  text: string
): string | null {
  if (script.flow.actionPointsPerRound <= 0) return "本局未开启技能系统";
  const charId = state.seats[fromSeat]?.characterId;
  const skill = script.characters.find((c) => c.id === charId)?.privateCard.skills.find((s) => s.id === skillId);
  if (!skill) return "你没有这张技能卡";
  if (skill.phase !== state.phase) return "该技能不能在这个阶段使用";
  if (skill.once && (state.usedSkills ?? []).includes(`${fromSeat}:${skillId}`)) return "该技能已经用过";
  if (skill.cost > (state.actionPoints?.[String(fromSeat)] ?? 0)) return "行动点不足";
  if (skill.effect === "verify") {
    if (toSeat === undefined || !activeSeats(state).includes(toSeat)) return "质询对象不合法";
    if (toSeat === fromSeat) return "不能质询自己";
    if (state.seats[toSeat]?.kind !== "ai") return "质询技能只能对 AI 玩家使用";
    if (!text) return "请输入质询问题";
  }
  return null;
}

/** 技能质询的强制回答提示：AI 不允许回避。 */
export function forcedAnswerHint(question: string): string {
  return `${question}【技能质询】这是被技能强制要求的回答：必须正面回应问题本身，不得回避、不得反问、不得转移话题（可以藏秘密，但答案要对得上问题）。`;
}

/** 已解锁的幕：搜证/讨论阶段按 roundStart ≤ 当前轮次解锁；投票阶段视为全部解锁（投票必在所有搜证轮之后）。 */
export function unlockedActs(acts: ActV2[], state: Pick<GameState, "phase" | "round">): ActV2[] {
  if (!acts.length) return [];
  if (state.phase === "VOTE") return acts;
  if (state.phase !== "SEARCH" && state.phase !== "DISCUSSION") return [];
  return acts.filter((a) => a.roundStart <= state.round);
}
