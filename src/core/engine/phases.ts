import { db } from "@/lib/db";
import { fullTimelineText, methodText, resolveFinaleOutcome, revealText } from "@/core/script/compat";
import { publish } from "./bus";
import { activeSeats } from "./state";
import { computeQuizResult, ensureDiscussionState, nextAfterSearch, QUESTIONS_PER_PLAYER } from "./flow";
import type { GameEngine } from "./engine";
import { scheduleEndedEviction } from "./registry";
import { dispatchDmTurn } from "./turns";
import { maybeScheduleSummarize } from "./social";
import type { GameState } from "./types";

/**
 * ★ 阶段流转 handler（批次 I1 自 engine.ts 拆出）★：
 * 每个阶段切换 = 状态重置 + DM 宣场（锁外流式）+ 挂 AI 读本定时器等。
 * 引擎实例以参数注入，对 engine.ts 只有 type-only 依赖，不构成运行时环。
 */

export async function beginGame(e: GameEngine): Promise<void> {
  e.state.phase = "READING";
  e.state.round = 0;
  await e.persist();
  dispatchDmTurn(
    e,
    `游戏开始。公开案件背景已经由界面展示，请不要复述任何背景、死者或发现经过。只用不超过两句话营造简短气氛，并宣布进入【读本环节】：每位玩家请阅读自己的角色剧本，读完后点击“我准备好了”。`,
    "READING",
    0,
    async () => {}
  );
  // AI 座位陆续"读完"
  const ais = activeSeats(e.state).filter((i) => e.state.seats[i].kind === "ai");
  ais.forEach((seat, i) => {
    e.schedule(`ready:${seat}`, async () => {
      if (e.state.readySeats.includes(seat)) return;
      e.state.readySeats.push(seat);
      await e.persist();
      await e.tickInner();
    }, 5000 + i * 3500);
  });
}

/** 常规阶段切换使用确定性短提示，避免重复生成背景叙事。 */
async function announcePhase(
  e: GameEngine,
  text: string,
  phase: GameState["phase"],
  round: number,
  after: () => Promise<void>,
): Promise<void> {
  await e.recordEvent({
    type: "phase",
    phase,
    round,
    fromSeat: null,
    toSeat: null,
    visibility: "public",
    content: { text, phase, round },
  });
  await after();
}

export async function transitionSelfIntro(e: GameEngine): Promise<void> {
  e.state.phase = "SELF_INTRO";
  e.state.round = 1;
  e.state.spokenSeats = [];
  e.state.suggestions = {};
  e.searchAsked.clear();
  e.turnAsked.clear();
  const first = activeSeats(e.state)[0];
  e.state.turnSeat = first;
  await e.persist();
  await announcePhase(e, "进入【自我介绍】环节。请按座位顺序简要介绍你与死者的关系和今晚的大致行踪。", "SELF_INTRO", 1, async () => {
    await e.tickInner();
  });
}

/** 自我介绍多轮（flow.selfIntroRounds>1）：全员讲完后重开下一轮 */
export async function advanceSelfIntroRound(e: GameEngine): Promise<void> {
  e.state.round += 1;
  e.state.spokenSeats = [];
  e.state.suggestions = {};
  e.turnAsked.clear();
  e.state.turnSeat = activeSeats(e.state)[0];
  await e.persist();
  await announcePhase(
    e,
    `进入【自我介绍】第 ${e.state.round} 轮。请补充遗漏的信息，或回应他人提出的疑点。`,
    "SELF_INTRO",
    e.state.round,
    async () => {
      await e.tickInner();
    }
  );
}

export async function transitionSearch(e: GameEngine, round: number): Promise<void> {
  e.state.phase = "SEARCH";
  e.state.round = round;
  e.state.searchChoices = {};
  e.state.pendingPublish = {};
  e.state.searchDealtRound = 0;
  e.searchAsked.clear();
  e.publishAsked.clear();
  e.turnAsked.clear();
  resetActionPoints(e);
  await e.persist();
  // 分幕读本：该轮对应的幕合并在同一份旁白里宣读，角色卡 stages 随之解锁
  const actBriefs = e.script.flow.acts
    .filter((a) => a.roundStart === round)
    .map((act) => {
      const brief = act.brief?.length ? " " + act.brief.map((b) => ("text" in b ? b.text : "")).join(" ") : "";
      return `【第${round}幕 · ${act.title}】${brief}`.trim();
    });
  await announcePhase(
    e,
    [`进入【第 ${round} 轮搜证】。每位玩家选择一个地点；获得线索后可选择公开或私藏。共 ${e.script.flow.searchRounds} 轮。`, ...actBriefs].join("\n\n"),
    "SEARCH",
    round,
    async () => {
      maybeScheduleSummarize(e);
      await e.tickInner();
    }
  );
}

export async function transitionDiscussion(e: GameEngine, round: number): Promise<void> {
  e.state.phase = "DISCUSSION";
  e.state.round = round;
  e.state.spokenSeats = [];
  e.state.interjections = 0;
  e.state.pendingAnswer = null;
  e.state.suggestions = {};
  ensureDiscussionState(e.state);
  // 每轮讨论提问配额重置（ensureDiscussionState 只补缺值，不会恢复已用完的额度）
  for (const seat of activeSeats(e.state)) e.state.questionsLeft[String(seat)] = QUESTIONS_PER_PLAYER;
  e.searchAsked.clear();
  e.turnAsked.clear();
  e.aiDiscussionAsked.clear();
  e.whisperAsked.clear();
  e.suggestAsked.clear();
  resetActionPoints(e);
  e.state.turnSeat = activeSeats(e.state)[0];
  await e.persist();
  maybeScheduleSummarize(e);
  await announcePhase(
    e,
    `进入【第 ${round} 轮圆桌讨论】。按座位顺序发言，每人可当众提问三次；被问到的人需要当场回答。你可以陈述、提问或回应他人。`,
    "DISCUSSION",
    round,
    async () => {
      await e.tickInner();
    }
  );
}

/** 每轮行动点重置：仅当技能系统开启（actionPointsPerRound > 0）时按活跃座位发点 */
export function resetActionPoints(e: GameEngine): void {
  e.state.actionPoints = {};
  if (e.script.flow.actionPointsPerRound > 0) {
    for (const seat of activeSeats(e.state)) {
      e.state.actionPoints[String(seat)] = e.script.flow.actionPointsPerRound;
    }
  }
}

export async function transitionVote(e: GameEngine): Promise<void> {
  e.state.phase = "VOTE";
  e.state.round = 1;
  e.state.votes = {};
  e.state.quizAnswers = {};
  e.state.suggestions = {};
  e.aiVoteAsked.clear();
  e.aiQuizAsked.clear();
  e.turnAsked.clear();
  e.state.turnSeat = activeSeats(e.state)[0];
  const voteMode = e.script.flow.voteMode;
  const task =
    voteMode === "choice"
      ? "讨论结束，宣布进入【复盘答题】环节：请每位玩家根据自己收集到的情报完成复盘答题卡（全部提交后立即揭晓答案与真相）。"
      : voteMode === "hybrid"
        ? "讨论结束，宣布进入【终局】环节：请每位玩家指认你认为的真凶并说明一句话理由，同时完成复盘答题卡（全部完成后立即揭晓真相与答案）。"
        : "讨论结束，宣布进入【投票】环节：请每位玩家指认你认为的真凶，并说明一句话理由。投票结束后将立即揭晓真相。";
  await e.persist();
  await announcePhase(e, task.replace(/^讨论结束，宣布进入/, "进入").replace(/环节：/g, "环节。"), "VOTE", 1, async () => {
    await e.tickInner();
  });
}

/** 答题复盘简报（DM 任务用）：每题正确答案 + 全场作答分布 */
export function quizBrief(e: GameEngine): string {
  const quiz = e.state.quizResult;
  if (!quiz) return "";
  return e.script.ending.quiz
    .map((q) => {
      const stat = quiz.perQuestion.find((p) => p.questionId === q.id);
      const correctLabel = q.options.find((o) => o.id === stat?.correctOptionId)?.label ?? "?";
      const dist = q.options.map((o) => `${o.label}×${stat?.counts[o.id] ?? 0}`).join("、");
      return `「${q.prompt}」正确答案：${correctLabel}（${dist}）`;
    })
    .join("；");
}

/** 计票判定（批次 J 定规）：并列最高票=平票=指认失败；无人投票/还原本/真凶未入座一律不判「被抓」。 */
export function tallyVotes(args: { counts: Record<string, number>; culpritSeat: number; voteMode: string }): {
  culpritSeat: number;
  caught: boolean;
  tiedSeats?: number[];
} {
  const { counts, culpritSeat, voteMode } = args;
  let topCount = 0;
  for (const n of Object.values(counts)) if (n > topCount) topCount = n;
  const tiedSeats = Object.keys(counts)
    .filter((k) => counts[k] === topCount)
    .map(Number)
    .sort((a, b) => a - b);
  const decisive = topCount > 0 && tiedSeats.length === 1;
  return {
    culpritSeat,
    caught: decisive && voteMode !== "choice" && tiedSeats[0] === culpritSeat,
    ...(topCount > 0 && tiedSeats.length > 1 ? { tiedSeats } : {}),
  };
}

export async function transitionReveal(e: GameEngine): Promise<void> {
  if (!e.state.voteResult) {
    const voteMode = e.script.flow.voteMode;
    const counts: Record<string, number> = {};
    for (const v of Object.values(e.state.votes)) counts[String(v.target)] = (counts[String(v.target)] ?? 0) + 1;
    const culpritSeat = e.state.seats.findIndex((s) => s.kind !== "empty" && s.characterId === e.script.truth.culpritId);
    e.state.voteResult = { counts, ...tallyVotes({ counts, culpritSeat, voteMode }) };
    if (e.script.ending.quiz.length) {
      e.state.quizResult = computeQuizResult(e.script.ending.quiz, e.state.quizAnswers ?? {});
    }
    e.state.phase = "REVEAL";
    e.state.round = 0;
    await e.persist();
  }
  // 幂等推进：中途任一步失败（如 DB 抖动）后，下一次 tick/玩家动作会经 step() 的 REVEAL 分支重入
  await finishReveal(e);
}

/** 幂等收尾：DM 宣读复盘 → reveal 事件 → ENDED → 结算。已做完的步骤按事件流/状态跳过。 */
export async function finishReveal(e: GameEngine): Promise<void> {
  const result = e.state.voteResult;
  if (!result) return;

  const finale = resolveFinaleOutcome(e.script, result);

  // 已宣读过（如重试重入）：直接推进终局
  if (e.events.some((ev) => ev.type === "reveal")) {
    const hasEndedEvent = e.events.some((ev) => ev.type === "phase" && ev.content.phase === "ENDED");
    if (e.state.phase !== "ENDED") {
      e.state.phase = "ENDED";
      await e.persist();
    }
    if (!hasEndedEvent) {
      await e.recordEvent({
        type: "phase",
        phase: "ENDED",
        round: 0,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { phase: "ENDED", round: 0, text: "" },
      });
    }
    await finalizeEnded(e);
    return;
  }

  const voteMode = e.script.flow.voteMode;
  const culpritName = e.script.characters.find((c) => c.id === e.script.truth.culpritId)?.name ?? "?";
  const culpritSeated = result.culpritSeat >= 0 && !!e.state.seats[result.culpritSeat];
  const voteBrief = Object.entries(result.counts)
    .map(([k, n]) => `座位${Number(k) + 1} 得 ${n} 票`)
    .join("，") || "无人投票";
  let task: string;
  if (voteMode === "choice") {
    task = `直接按案件事实复盘，不要重复开场背景或场景氛围。本局为还原本，不指认凶手。请逐题宣读正确答案与全场作答分布（${quizBrief(e)}），按得分点评全场还原度，然后完整说明手法、时间线和关键证据链。`;
  } else {
    const verdict = !culpritSeated ? finale.verdict : result.caught ? `凶手是 ${e.speakerName(result.culpritSeat)}，已被成功指认。` : finale.verdict;
    task = `直接进入案件复盘，不要重述开场背景或描写场景氛围。公布投票结果（${voteBrief}），然后宣布揭晓真相：${verdict}。请依据剧本事实账本完整说明手法、时间线和关键证据链，并点评玩家今晚的表现。`;
    if (e.state.quizResult) task += `随后进行答题复盘：逐题宣读正确答案与全场作答分布（${quizBrief(e)}），按得分点评各位玩家的还原度。`;
  }

  // DM 宣读（锁外流式）→ 提交阶段按序落 reveal/ENDED 事件并结算
  dispatchDmTurn(e, task, "REVEAL", 0, async () => {
    if (!e.events.some((ev) => ev.type === "reveal")) {
      await e.recordEvent({
        type: "reveal",
        phase: "REVEAL",
        round: 0,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: {
          culpritSeat: result.culpritSeat,
          culpritName,
          caught: result.caught,
          ...(result.tiedSeats ? { tiedSeats: result.tiedSeats } : {}),
          counts: result.counts,
          method: methodText(e.script),
          fullTimeline: fullTimelineText(e.script),
          reveal: revealText(e.script),
          finale,
          ...(e.state.quizResult ? { quiz: e.state.quizResult } : {}),
        },
      });
    }
    if (e.state.phase !== "ENDED") {
      e.state.phase = "ENDED";
      // 快照权威：先落终局状态，再补发事件；事件写入失败由 REVEAL/ENDED 重试分支兜底
      await e.persist();
      await e.recordEvent({
        type: "phase",
        phase: "ENDED",
        round: 0,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { phase: "ENDED", round: 0, text: "" },
      });
    }
    await finalizeEnded(e);
  });
}

/** 结算：对局/房间置为已结束 + 广播终局。两条写同事务，幂等，失败可在下一次 tick 重试。 */
export async function finalizeEnded(e: GameEngine): Promise<void> {
  if (e.endFinalized) return;
  await db.$transaction(async (tx) => {
    const ended = await tx.game.update({ where: { id: e.gameId }, data: { status: "ended", endedAt: new Date() } });
    await tx.room.update({ where: { id: ended.roomId }, data: { status: "ended" } });
  });
  e.endFinalized = true;
  publish(e.gameId, { kind: "end", lastEventSeq: e.events.at(-1)?.seq ?? "0" });
  scheduleEndedEviction(e);
}

export async function afterSearchPhase(e: GameEngine): Promise<void> {
  if (e.state.phase !== "SEARCH") return;
  const next = nextAfterSearch(e.state.round, e.script.flow.searchRounds, e.script.flow.discussionRounds);
  if (next === "DISCUSSION") await transitionDiscussion(e, e.state.round);
  else if (next === "SEARCH") await transitionSearch(e, e.state.round + 1);
  else await transitionVote(e);
}
