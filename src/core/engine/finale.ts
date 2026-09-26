import { db } from "@/lib/db";
import { agent } from "@/core/agents";
import { activeSeats } from "./state";
import { finaleMissing } from "./flow";
import { AI_DECISION_TIMEOUT_MS, withTimeout } from "./util";
import { armHumanTimeout } from "./human-turn";
import { jevVoteFallback, shadowVote } from "@/core/jev/live";
import { legalPublicEvidenceIds } from "./evidence";
import type { GameEngine } from "./engine";

/**
 * ★ 终局域（批次 I1 自 engine.ts 拆出）★：投票 / 复盘答题的 AI 决策、超时兜底与真人限时。
 */

/** 记录一票：state.votes 为权威源，Vote 表写入失败重试一次并留痕（DM 视图优先读内存态）。 */

export async function recordVote(e: GameEngine, seat: number, target: number, reason?: string, evidenceIds?: string[]): Promise<void> {
  const legalEvidence = legalPublicEvidenceIds(e, evidenceIds);
  e.state.votes[String(seat)] = { target, reason, ...(legalEvidence.length ? { evidenceIds: legalEvidence } : {}) };
  try {
    await db.vote.create({ data: { gameId: e.gameId, seatIndex: seat, targetIndex: target, reason } });
  } catch (err) {
    console.error(`[engine ${e.gameId}] 投票落库失败（seat ${seat}），重试一次：`, err);
    await db.vote
      .create({ data: { gameId: e.gameId, seatIndex: seat, targetIndex: target, reason } })
      .catch((err2) => console.error(`[engine ${e.gameId}] 投票落库重试仍失败，仅存在于内存态：`, err2));
  }
  await e.recordEvent({
    type: "vote",
    phase: e.state.phase,
    round: e.state.round,
    fromSeat: seat,
    toSeat: null,
    visibility: `seat:${seat}`,
    content: { target, reason, ...(legalEvidence.length ? { evidenceIds: legalEvidence } : {}), text: `你投给了 ${e.speakerName(target)}${reason ? `：${reason}` : ""}` },
  });
  const seats = activeSeats(e.state);
  if (seats.every((index) => e.state.votes[String(index)])) {
    const counts: Record<string, number> = {};
    for (const index of seats) {
      const targetIndex = e.state.votes[String(index)]?.target;
      if (targetIndex === undefined) continue;
      counts[String(targetIndex)] = (counts[String(targetIndex)] ?? 0) + 1;
    }
    const text = seats
      .map((index) => {
        const vote = e.state.votes[String(index)];
        if (!vote) return "";
        return `${e.speakerName(index)} 投给 ${e.speakerName(vote.target)}${vote.reason ? `：${vote.reason}` : ""}`;
      })
      .filter(Boolean)
      .join("\n");
    await e.recordEvent({
      type: "vote",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { counts, text, tally: true },
    });
  }
  await e.persist();
}

/** AI 投票决策（锁外 LLM），完成后只把短暂提交排队回互斥锁。 */
export function queueAiVote(e: GameEngine, seat: number, candidates: number[]): void {
  if (e.aiVoteAsked.has(seat)) return;
  e.aiVoteAsked.add(seat);
  e.scheduleBackground(`vote-ai:${seat}`, async () => {
    let vote: { target: number; reason: string; evidenceIds: string[] };
    let modelTarget: number | null = null;
    try {
      vote = await withTimeout(agent.playerVote(e.ctx(), seat, candidates), AI_DECISION_TIMEOUT_MS);
      modelTarget = vote.target;
    } catch {
      const jev = await jevVoteFallback(e.ctx(), seat);
      vote = { target: jev?.target ?? candidates[Math.floor(Math.random() * candidates.length)], reason: "", evidenceIds: [] };
    }
    if (modelTarget !== null) void shadowVote(e.ctx(), seat, modelTarget);
    await e.exclusive(async () => {
      if (e.state.phase !== "VOTE" || e.state.votes[String(seat)]) return;
      const target = candidates.includes(vote.target) ? vote.target : candidates[0];
      if (target === undefined) return;
      const evidence = legalPublicEvidenceIds(e, vote.evidenceIds);
      const fallback = e.script.clues.filter((clue) => e.state.clueStates[clue.id]?.isPublic).slice(0, 1).map((clue) => clue.id);
      await recordVote(e, seat, target, evidence.length ? vote.reason : "依据公开材料暂作判断，仍需核实。", evidence.length ? evidence : fallback);
      await e.tickInner();
    });
  }, 50 + seat * 40);
}

/** AI 复盘答题（锁外 LLM）：解析失败/缺题时随机合法选项兜底，保证流程闭环 */
export function queueAiQuiz(e: GameEngine, seat: number): void {
  if (e.aiQuizAsked.has(seat)) return;
  e.aiQuizAsked.add(seat);
  const questions = e.script.ending.quiz;
  e.scheduleBackground(`quiz-ai:${seat}`, async () => {
    let answers: Record<string, string> = {};
    try {
      answers = await withTimeout(agent.quizAnswer(e.ctx(), seat, questions), AI_DECISION_TIMEOUT_MS);
    } catch {
      answers = {};
    }
    await e.exclusive(async () => {
      if (e.state.phase !== "VOTE" || e.state.quizAnswers?.[String(seat)]) return;
      for (const q of questions) {
        if (!q.options.some((o) => o.id === answers[q.id])) {
          answers[q.id] = q.options[Math.floor(Math.random() * q.options.length)].id;
        }
      }
      e.state.quizAnswers ??= {};
      e.state.quizAnswers[String(seat)] = answers;
      await e.persist();
      await e.tickInner();
    });
  }, 50 + seat * 40);
}

/** 超时兜底：为某座位随机补齐全部答题 */
export async function randomQuizAnswers(e: GameEngine, seat: number, notice?: string): Promise<void> {
  const answers: Record<string, string> = {};
  for (const q of e.script.ending.quiz) {
    answers[q.id] = q.options[Math.floor(Math.random() * q.options.length)].id;
  }
  e.state.quizAnswers ??= {};
  e.state.quizAnswers[String(seat)] = answers;
  if (notice) await e.systemSay(notice, seat);
  await e.persist();
}

/** VOTE 阶段人类座位的限时与提示（投票+答题合一；某项完成后由 step 按剩余项重新武装） */
export async function armVotePhaseHuman(e: GameEngine, seat: number): Promise<void> {
  const voteMode = e.script.flow.voteMode;
  const hasQuiz = e.script.ending.quiz.length > 0;
  const missing = finaleMissing(e.state, { voteMode, seats: activeSeats(e.state), hasQuiz });
  const needVote = missing.votes.includes(seat);
  const needQuiz = missing.quiz.includes(seat);
  await armHumanTimeout(e, seat, "投票/作答", async () => {
    const now = finaleMissing(e.state, { voteMode, seats: activeSeats(e.state), hasQuiz });
    if (now.votes.includes(seat)) {
      const candidates = activeSeats(e.state).filter((i) => i !== seat);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (!e.state.votes[String(seat)] && target !== undefined) {
        await recordVote(e, seat, target, "（超时，系统代投；依据公开材料暂作判断）", e.script.clues.filter((clue) => e.state.clueStates[clue.id]?.isPublic).slice(0, 1).map((clue) => clue.id));
      }
    }
    if (now.quiz.includes(seat)) await randomQuizAnswers(e, seat, "（超时，系统已代为作答。）");
    await e.tickInner();
  });
  const hint =
    needVote && needQuiz
      ? `请投票（左侧玩家列表点击"投票"），并完成复盘答题卡（一次性整卷提交）。`
      : needQuiz
        ? `请完成复盘答题卡（左侧面板，一次性整卷提交）。`
        : `请投票：选择你认为的真凶（左侧玩家列表点击"投票"）。`;
  await e.systemSay(hint, seat);
}
