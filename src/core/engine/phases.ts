import { db } from "@/lib/db";
import { fullTimelineText, methodText, revealText, winText } from "@/core/script/compat";
import { publish } from "./bus";
import { activeSeats } from "./state";
import { computeQuizResult, ensureDiscussionState, nextAfterSearch, QUESTIONS_PER_PLAYER } from "./flow";
import type { GameEngine } from "./engine";
import { scheduleEndedEviction } from "./registry";
import { dispatchDmTurn } from "./turns";
import { maybeScheduleSummarize } from "./social";

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
    `游戏开始。请宣布开场：介绍剧本《${e.script.meta.title}》的背景（可直接取用公开背景大意）、案件情况（${e.script.meta.title} 中的死者与发现经过），宣布进入【读本环节】：每位玩家请阅读自己的角色剧本，读完后点击"我准备好了"。`,
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
  dispatchDmTurn(e, "宣布进入【自我介绍】环节：请各位按座位顺序简要介绍自己与死者的关系、今晚的大致行踪。", "SELF_INTRO", 1, async () => {
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
  dispatchDmTurn(
    e,
    `宣布进入【自我介绍】第 ${e.state.round} 轮：请补充上一轮没说完的信息，或回应他人提到的疑点。`,
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
  dispatchDmTurn(
    e,
    [`宣布进入【第 ${round} 轮搜证】：每位玩家选择一个地点进行搜证，找到的线索可以选择当场公开或私藏。轮次共 ${e.script.flow.searchRounds} 轮。`, ...actBriefs].join("\n\n"),
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
  dispatchDmTurn(
    e,
    `宣布进入【第 ${round} 轮圆桌讨论】：按座位顺序轮流发言，每人可当众提问三次。轮到你时请陈述或提问，被问到的人需要当场回答。发言时点名某位玩家，对方可能会立即插话回应；各位也可能收到其他玩家的悄悄私信，请留意界面提示。`,
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
  dispatchDmTurn(e, task, "VOTE", 1, async () => {
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

export async function transitionReveal(e: GameEngine): Promise<void> {
  if (!e.state.voteResult) {
    const voteMode = e.script.flow.voteMode;
    const counts: Record<string, number> = {};
    for (const v of Object.values(e.state.votes)) counts[String(v.target)] = (counts[String(v.target)] ?? 0) + 1;
    const culpritSeat = e.state.seats.findIndex((s) => s.kind !== "empty" && s.characterId === e.script.truth.culpritId);
    let topSeat = -1;
    let topCount = -1;
    for (const [k, n] of Object.entries(counts)) {
      if (n > topCount) {
        topCount = n;
        topSeat = Number(k);
      }
    }
    e.state.voteResult = { counts, culpritSeat, caught: voteMode === "choice" ? false : topSeat === culpritSeat };
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

  // 已宣读过（如重试重入）：直接推进终局
  if (e.events.some((ev) => ev.type === "reveal")) {
    if (e.state.phase !== "ENDED") {
      e.state.phase = "ENDED";
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
    return;
  }

  const voteMode = e.script.flow.voteMode;
  const caughtName = e.state.seats[result.culpritSeat] ? e.speakerName(result.culpritSeat) : "?";
  let task: string;
  if (voteMode === "choice") {
    task = `复盘时刻：本局为还原本，不指认凶手。请逐题宣读正确答案与全场作答分布（${quizBrief(e)}），按得分点评全场还原度，然后完整宣读真相复盘：手法、完整时间线、关键证据链。`;
  } else {
    task = `公布投票结果（${Object.entries(result.counts).map(([k, n]) => `座位${Number(k) + 1} 得 ${n} 票`).join("，") || "无人投票"}），然后宣布揭晓真相：凶手是 ${caughtName}。请完整宣读真相复盘：手法、完整时间线、关键证据链，以及点评各位玩家今晚的表现（谁误导了大家、谁的推理最接近真相）。`;
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
          culpritName: caughtName,
          caught: result.caught,
          counts: result.counts,
          method: methodText(e.script),
          fullTimeline: fullTimelineText(e.script),
          reveal: revealText(e.script),
          winText: winText(e.script),
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
  publish(e.gameId, { kind: "end" });
  scheduleEndedEviction(e);
}

export async function afterSearchPhase(e: GameEngine): Promise<void> {
  if (e.state.phase !== "SEARCH") return;
  const next = nextAfterSearch(e.state.round, e.script.flow.searchRounds, e.script.flow.discussionRounds);
  if (next === "DISCUSSION") await transitionDiscussion(e, e.state.round);
  else if (next === "SEARCH") await transitionSearch(e, e.state.round + 1);
  else await transitionVote(e);
}
