import { publish } from "./bus";
import type { GameEngine } from "./engine";
import type { GameState } from "./types";
import { AI_DECISION_TIMEOUT_MS, msgOf, withTimeout } from "./util";
import { agent } from "@/core/agents";
import { renderActionPlan } from "@/core/agents/plan";

/**
 * ★ 回合执行器（TurnScheduler）★：正式回合（AI 发言 / DM 旁白）的 LLM 工作移出互斥锁。
 * tick（锁内，毫秒级）判定回合 → produce 在锁外生成（流式 delta 实时可见）
 * → exclusive 内以 turnToken/边界重校验后应用状态推进。
 * 任何失败都推进回合（跳过或系统提示），回合绝不悬空；看门狗兜底强制推进。
 * （批次 I1 自 engine.ts 拆出；引擎实例以参数注入，类型依赖为 type-only，不构成运行时环。）
 */

/**
 * AI 发言（真流式）：句子级增量守卫随到随播，泄露句不会被放出；
 * 流式失败时回退到非流式（带重试 + fallback 链 + 全文守卫）。
 */
export function dispatchTurn(
  e: GameEngine,
  args: {
    timeoutMs: number;
    /** 锁外：生成最终文本（流式推送 + 降级 + 修正） */
    produce: (abortSignal: AbortSignal) => Promise<string>;
    /** 锁内：回合是否已失效（阶段/轮次/回合座位变化） */
    stale: () => boolean;
    /** 锁内：应用结果与状态推进（text 可为空串 = 跳过） */
    commit: (text: string) => Promise<void>;
    /** produce 整体失败/看门狗超时：强制推进回合 */
    onAbort: () => Promise<void>;
  }
): void {
  if (e.turnInFlight) {
    e.pendingTick = true;
    return;
  }
  e.turnInFlight = true;
  const token = ++e.turnToken;
  const controller = new AbortController();
  e.activeAbortController = controller;
  e.activeGenerationBoundary = { phase: e.state.phase, round: e.state.round, turnSeat: e.state.turnSeat };
  e.scheduleBackground(`gen:${token}`, async () => {
    let text = "";
    try {
      text = await args.produce(controller.signal);
    } catch (err) {
      console.error(`[engine] 回合 ${token} 生成失败:`, err);
      await e.exclusive(async () => {
        e.turnInFlight = false;
        if (e.activeAbortController === controller) e.activeAbortController = null;
        if (e.activeGenerationBoundary && e.turnToken === token) e.activeGenerationBoundary = null;
        publish(e.gameId, { kind: "thinking", seat: null, audience: "public", generationId: String(token) });
        if (!args.stale()) await args.onAbort();
        e.continueTick();
      });
      return;
    }
    await e.exclusive(async () => {
      e.turnInFlight = false;
      if (e.activeAbortController === controller) e.activeAbortController = null;
      if (e.activeGenerationBoundary && e.turnToken === token) e.activeGenerationBoundary = null;
      publish(e.gameId, { kind: "thinking", seat: null, audience: "public", generationId: String(token) });
      if (e.turnToken !== token || args.stale()) {
        e.continueTick(); // 回合已失效（阶段/轮次/座位变化），丢弃迟到产出
        return;
      }
      await args.commit(text);
      e.continueTick();
    });
  }, 30);
  // 看门狗：produce 全链路（含降级）仍卡死时强制推进，回合绝不悬空
  e.schedule(`turn-watchdog:${token}`, async () => {
    if (!e.turnInFlight || e.turnToken !== token) return;
    console.error(`[engine] 回合 ${token} 超时未完成,强制跳过`);
    await e.exclusive(async () => {
      if (!e.turnInFlight || e.turnToken !== token) return;
      e.turnInFlight = false;
      controller.abort();
      if (e.activeAbortController === controller) e.activeAbortController = null;
      if (e.activeGenerationBoundary && e.turnToken === token) e.activeGenerationBoundary = null;
      publish(e.gameId, { kind: "thinking", seat: null, audience: "public", generationId: String(token) });
      await args.onAbort();
      e.continueTick();
    });
  }, args.timeoutMs * 2 + 5_000);
}

/** AI 玩家正式发言回合（锁外生成，锁内提交）。after = 提交后的状态推进。 */
export function dispatchPlayerSpeech(
  e: GameEngine,
  seatIndex: number,
  opts: { intro?: boolean; hint?: string },
  after: () => Promise<void>
): void {
  const boundary = { phase: e.state.phase, round: e.state.round, turnSeat: e.state.turnSeat };
  dispatchTurn(e, {
    timeoutMs: AI_DECISION_TIMEOUT_MS * 2 + 10_000,
    produce: async (abortSignal) => {
      publish(e.gameId, { kind: "thinking", seat: seatIndex, audience: "public", generationId: String(e.turnToken) });
      let plan = null;
      try {
        plan = await withTimeout(agent.playerActionPlan(e.ctx(), seatIndex), Math.min(20_000, AI_DECISION_TIMEOUT_MS));
      } catch {
        plan = null;
      }
      if (plan && !abortSignal.aborted) {
        await e.exclusive(async () => {
          if (e.state.phase === boundary.phase && e.state.round === boundary.round && e.state.turnSeat === boundary.turnSeat) {
            e.state.actionPlans ??= {};
            e.state.actionPlans[String(seatIndex)] = plan!;
            await e.persist();
          }
        });
      }
      let text = await consumeStream(
        (signal) => agent.streamPlayerSpeech(e.ctx(), seatIndex, { ...opts, extraInstruction: plan ? `${opts.hint ?? ""}\n${renderActionPlan(plan)}` : undefined, abortSignal: signal, generationId: String(e.turnToken) }),
        (delta) => publish(e.gameId, { kind: "delta", seat: seatIndex, text: delta, audience: "public" }),
        AI_DECISION_TIMEOUT_MS,
        abortSignal
      );
      if (!text.trim()) {
        try {
          text = await withTimeout(agent.playerSpeak(e.ctx(), seatIndex, { ...opts, abortSignal, generationId: String(e.turnToken) }), AI_DECISION_TIMEOUT_MS);
        } catch (err) {
          await e.systemSay(`（AI 玩家「${e.speakerName(seatIndex)}」思考时遇到问题：${msgOf(err)}。场内玩家可稍作等待或继续。）`);
          return "";
        }
      }
      if (!text.trim()) {
        await e.systemSay(`（AI 玩家「${e.speakerName(seatIndex)}」没有组织出有效发言，先跳过。）`);
        return "";
      }
      return agent.refineSpeech(e.ctx(), seatIndex, text, { abortSignal, generationId: String(e.turnToken) });
    },
    stale: () =>
      e.state.phase !== boundary.phase ||
      e.state.round !== boundary.round ||
      e.state.turnSeat !== boundary.turnSeat,
    commit: async (text) => {
      if (text.trim()) {
        await e.recordEvent({
          type: "speech",
          phase: e.state.phase,
          round: e.state.round,
          fromSeat: seatIndex,
          toSeat: null,
          visibility: "public",
          content: { text, speakerName: e.speakerName(seatIndex) },
        });
      }
      await after();
    },
    onAbort: async () => {
      await e.systemSay(`（AI 玩家「${e.speakerName(seatIndex)}」超时，本回合跳过。）`);
      await after();
    },
  });
}

/** 被提问的 AI 座位作答回合。提交前提：pendingAnswer 仍是这个问题（真人拒绝/超时则丢弃）。 */
export function dispatchAnswerTurn(e: GameEngine, target: number, hint: string, after: () => Promise<void>): void {
  const boundary = { pending: JSON.stringify(e.state.pendingAnswer), phase: e.state.phase, round: e.state.round, turnSeat: e.state.turnSeat };
  dispatchTurn(e, {
    timeoutMs: AI_DECISION_TIMEOUT_MS * 2 + 10_000,
    produce: async (abortSignal) => {
      publish(e.gameId, { kind: "thinking", seat: target, audience: "public", generationId: String(e.turnToken) });
      let text = await consumeStream(
        (signal) => agent.streamPlayerSpeech(e.ctx(), target, { hint, taskType: "answer", abortSignal: signal, generationId: String(e.turnToken) }),
        (delta) => publish(e.gameId, { kind: "delta", seat: target, text: delta, audience: "public" }),
        AI_DECISION_TIMEOUT_MS,
        abortSignal
      );
      if (!text.trim()) {
        text = await withTimeout(agent.playerSpeak(e.ctx(), target, { hint, taskType: "answer", abortSignal, generationId: String(e.turnToken) }), AI_DECISION_TIMEOUT_MS);
      }
      return agent.refineSpeech(e.ctx(), target, text, { abortSignal, generationId: String(e.turnToken) });
    },
    stale: () =>
      JSON.stringify(e.state.pendingAnswer) !== boundary.pending ||
      e.state.phase !== boundary.phase ||
      e.state.round !== boundary.round ||
      e.state.turnSeat !== boundary.turnSeat,
    commit: async (text) => {
      if (text.trim()) {
        await e.recordEvent({
          type: "speech",
          phase: e.state.phase,
          round: e.state.round,
          fromSeat: target,
          toSeat: null,
          visibility: "public",
          content: { text, speakerName: e.speakerName(target) },
        });
      }
      e.state.pendingAnswer = null;
      await e.persist();
      await after();
    },
    onAbort: async () => {
      await e.systemSay(`（AI 玩家「${e.speakerName(target)}」超时未作答，问题作废。）`);
      e.state.pendingAnswer = null;
      await e.persist();
      await after();
    },
  });
}

/** DM 旁白回合（锁外生成，锁内提交）。after = 旁白落库后的阶段推进。 */
export function dispatchDmTurn(
  e: GameEngine,
  task: string,
  phase: GameState["phase"],
  round: number,
  after: () => Promise<void>
): void {
  const boundary = { phase: e.state.phase, round: e.state.round };
  dispatchTurn(e, {
    timeoutMs: AI_DECISION_TIMEOUT_MS * 4 + 10_000,
    produce: async (abortSignal) => {
      publish(e.gameId, { kind: "thinking", seat: "dm", audience: "public", generationId: String(e.turnToken) });
      let text = await consumeStream(
        (signal) => agent.streamDmNarrate(e.ctx(), task, signal, String(e.turnToken)),
        (delta) => publish(e.gameId, { kind: "delta", seat: "dm", text: delta, audience: "public" }),
        AI_DECISION_TIMEOUT_MS * 2,
        abortSignal
      );
      if (!text.trim()) {
        try {
          text = await withTimeout(agent.dmNarrate(e.ctx(), task), AI_DECISION_TIMEOUT_MS * 2);
        } catch {
          text = "";
        }
      }
      if (!text.trim()) text = `（主持人正在准备：${task}）`;
      return text;
    },
    stale: () => e.state.phase !== boundary.phase || e.state.round !== boundary.round,
    commit: async (text) => {
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
    },
    onAbort: async () => {
      await e.recordEvent({
        type: "phase",
        phase,
        round,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { text: `（主持人正在准备：${task}）`, phase, round },
      });
      await after();
    },
  });
}

/**
 * 消费一个流式生成器：delta 边收边推（观众可见），整体受超时约束。
 * 超时后置 stopped 丢弃剩余输出（连接由 chatStream 内部 abortSignal 兜底关闭），
 * 避免残句在回退发言期间混进事件流。
 */
export async function consumeStream(
  makeStream: (abortSignal: AbortSignal) => AsyncGenerator<string>,
  onDelta: (delta: string) => void,
  timeoutMs: number,
  abortSignal: AbortSignal
): Promise<string> {
  let text = "";
  let stopped = false;
  const consume = async (): Promise<void> => {
    for await (const delta of makeStream(abortSignal)) {
      if (stopped) continue;
      text += delta;
      onDelta(delta);
    }
  };
  const tracked = consume();
  try {
    await withTimeout(tracked, timeoutMs);
  } catch {
    stopped = true;
    tracked.catch(() => {});
  }
  return text;
}
