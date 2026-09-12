import type { GameState, Phase, QuizResult } from "./types";
import { activeSeats } from "./state";
import type { ActV2, QuizQuestionV2, SkillV2 } from "@/core/script/v2/schema";

export const QUESTIONS_PER_PLAYER = 3;

export function nextAfterDiscussion(round: number, searchRounds: number, discussionRounds: number): Phase {
  if (round < searchRounds) return "SEARCH";
  if (round < discussionRounds) return "DISCUSSION";
  return "VOTE";
}

/**
 * 搜证第 R 轮结束后:第 R 轮的讨论必然还没发生,只要 R 在讨论轮数预算内就进讨论。
 * 之前用 `round < discussionRounds` 会把 searchRounds == discussionRounds 的最后一轮讨论跳过
 * （2/2 配置实际只讨论 1 轮,历史对局已印证）。
 */
export function nextAfterSearch(round: number, searchRounds: number, discussionRounds: number): Phase {
  if (round <= discussionRounds) return "DISCUSSION";
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
  state: Pick<GameState, "phase" | "seats" | "actionPoints" | "usedSkills" | "pendingAnswer">,
  fromSeat: number,
  skillId: string,
  toSeat: number | undefined,
  text: string
): string | null {
  if (state.pendingAnswer) return "已有待回答的提问，请等其结束后再发动技能";
  if (script.flow.actionPointsPerRound <= 0) return "本局未开启技能系统";
  const charId = state.seats[fromSeat]?.characterId;
  const skill = script.characters.find((c) => c.id === charId)?.privateCard.skills.find((s) => s.id === skillId);
  if (!skill) return "你没有这张技能卡";
  if (skill.phase !== state.phase) return "该技能不能在这个阶段使用";
  if (skill.once && (state.usedSkills ?? []).includes(`${fromSeat}:${skillId}`)) return "该技能已经用过";
  if (skill.cost > (state.actionPoints?.[String(fromSeat)] ?? 0)) return "行动点不足";
  if (skill.effect === "verify") {
    // 质询靠「被质询者当众作答」闭环，而这套机制只在圆桌讨论阶段存在：
    // 搜证阶段设了 pendingAnswer 也没人消费（会被 transitionDiscussion 抹掉），等于白扣行动点。
    if (state.phase !== "DISCUSSION") return "【质询】只能在圆桌讨论阶段发动";
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

/** 复盘答题的作答指令：题目清单 + JSON 输出模板 */
export function quizPrompt(questions: ReadonlyArray<QuizQuestionV2>): string {
  const list = questions
    .map((q) => `· ${q.id}：${q.prompt}\n  选项：${q.options.map((o) => `${o.id}=${o.label}`).join("；")}`)
    .join("\n");
  return `复盘在即，请根据你的情报与推理作答。请只输出 JSON：{"answers":[{"questionId":"...","optionId":"..."}]}。必须每题都答。\n题目：\n${list}`;
}

/**
 * 终局完成判定：VOTE 阶段还差谁没投票/没答题。
 * culprit 只看 votes；choice 只看 quiz；hybrid 两者都要。
 * hasQuiz=false 时 quiz 永远视为已交卷（防无题模式卡死）。
 */
export function finaleMissing(
  state: Pick<GameState, "votes" | "quizAnswers">,
  opts: { voteMode: "culprit" | "hybrid" | "choice"; seats: number[]; hasQuiz: boolean }
): { votes: number[]; quiz: number[] } {
  const votes = opts.voteMode === "choice" ? [] : opts.seats.filter((i) => !state.votes[String(i)]);
  const quiz = opts.voteMode === "culprit" || !opts.hasQuiz ? [] : opts.seats.filter((i) => !state.quizAnswers?.[String(i)]);
  return { votes, quiz };
}

/** 复盘答题计分：每题作答分布 + 正确项；每人 对/总/加权得分。 */
export function computeQuizResult(
  questions: ReadonlyArray<QuizQuestionV2>,
  answers: Record<string, Record<string, string>>
): QuizResult {
  const perSeat: QuizResult["perSeat"] = {};
  const perQuestion: QuizResult["perQuestion"] = [];
  for (const question of questions) {
    const counts: Record<string, number> = {};
    for (const option of question.options) counts[option.id] = 0;
    for (const [seat, sheet] of Object.entries(answers)) {
      const picked = sheet[question.id];
      if (!picked) continue;
      if (counts[picked] === undefined) counts[picked] = 0;
      counts[picked] += 1;
      const seatStat = (perSeat[seat] ??= { correct: 0, total: 0, score: 0 });
      seatStat.total += 1;
      if (picked === question.correctOptionId) {
        seatStat.correct += 1;
        seatStat.score += question.weight;
      }
    }
    perQuestion.push({ questionId: question.id, counts, correctOptionId: question.correctOptionId });
  }
  return { perSeat, perQuestion };
}

/** 已解锁的幕：搜证/讨论阶段按 roundStart ≤ 当前轮次解锁；投票阶段视为全部解锁（投票必在所有搜证轮之后）。 */
export function unlockedActs(acts: ActV2[], state: Pick<GameState, "phase" | "round">): ActV2[] {
  if (!acts.length) return [];
  if (state.phase === "VOTE") return acts;
  if (state.phase !== "SEARCH" && state.phase !== "DISCUSSION") return [];
  return acts.filter((a) => a.roundStart <= state.round);
}
