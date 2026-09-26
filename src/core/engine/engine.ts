import { runInteractionBeats, chooseInteraction } from "./interactions";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Room, Seat } from "@prisma/client";
import { clueText, parseScriptForRuntime, resolveLocation } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import type { AgentCtx } from "@/core/agents";
import { activeSeats, appendEvent, initialState, persistState } from "./state";
import { ensureDiscussionState, finaleMissing, nextAfterDiscussion, validateTransfer, validateUseSkill } from "./flow";
import type { EngineEvent, GameState, SeatInfo } from "./types";
import { createHash } from "node:crypto";
import { engineLoads, engines, rememberEngine } from "./registry";
import { msgOf } from "./util";
import {
  advanceSelfIntroRound,
  beginGame,
  finalizeEnded,
  finishReveal,
  transitionDiscussion,
  transitionReveal,
  transitionSearch,
  transitionSelfIntro,
  transitionVote,
} from "./phases";
import { dispatchPlayerSpeech } from "./turns";
import { clearSuggestions, maybeQueueInterjection, queueAiPrivateReply, queueEmbed, queueSuggestReply } from "./social";
import { armHumanTimeout, clearHumanTimeout, ensureHumanTimeout } from "./human-turn";
import {
  applyPublish,
  availableLocations,
  cluesAt,
  collectPublishDecisions,
  dispatchClues,
  finalizeSearchRound,
  fallbackLocations,
  NO_SEARCH_CHOICE,
  queueAiSearchChoice,
  seatCharacterId,
  skillOf,
  syncSeatClueIds,
} from "./search-deal";
import { armVotePhaseHuman, queueAiQuiz, queueAiVote, recordVote } from "./finale";
import { resolvePendingAnswer, runAiDiscussionTurn, submitQuestion } from "./discussion";
import { validateVoteEvidence } from "./evidence";

/**
 * ★ GameEngine——编排门面（批次 I1 拆分后）★
 *
 * 本类只保留：实例构造/注册（registry）、事件与状态的落库原语（recordEvent/persist）、
 * 互斥锁与定时器（exclusive/schedule/scheduleBackground）、主驱动（tick/step）、
 * 真人与 DM 的动作入口（handleAction/handleDmAction）。
 * 各功能域已按职责拆出为兄弟模块，均以 `(e: GameEngine, ...)` 形态接收引擎实例，
 * 对 engine.ts 只有 type-only 依赖，不构成运行时循环：
 * - phases.ts      阶段流转（beginGame / transition 系列 / finalizeEnded）
 * - turns.ts       回合执行器（锁外生成 → 锁内提交 + 看门狗）
 * - social.ts      插话/私信/推荐回复/向量写入/轮次摘要
 * - search-deal.ts 搜证域（地点/线索发放/公开决策）
 * - discussion.ts  讨论域（提问/作答/AI 讨论回合）
 * - finale.ts      终局域（投票/复盘答题/超时兜底）
 * - human-turn.ts  真人限时（arm/ensure/clear）
 * - registry.ts    常驻实例表与终局延迟驱逐
 * - util.ts        小工具与超时常量
 */

/** 重启恢复时事件回放上限：只取最近 N 条，超长对局历史不进内存。 */
const EVENT_REPLAY_LIMIT = 800;

export interface GameAction {
  type: "ready" | "speak" | "skip" | "ask" | "choose_location" | "publish" | "vote" | "private_chat" | "rush" | "transfer" | "use_skill" | "answer_quiz" | "interaction";
  beatId?: string;
  choiceId?: string;
  text?: string;
  location?: string;
  clueId?: string;
  skillId?: string;
  publish?: boolean;
  target?: number;
  reason?: string;
  evidenceIds?: string[];
  toSeat?: number;
  answers?: Array<{ questionId: string; optionId: string }>;
}

export class GameEngine {
  readonly gameId: string;
  script: ScriptDocV2;
  state: GameState;
  events: EngineEvent[] = [];

  // ============ 内部调度状态：供引擎功能域模块使用（API 层不要直接触碰） ============

  /** 键名化的定时器：ready:* AI 读本；human-turn:* 真人超时；gen:* AI 生成；pub:* 公开决策 */
  timers = new Map<string, NodeJS.Timeout>();
  pendingTick = false;
  turnAsked = new Set<string>();
  searchAsked = new Set<number>();
  publishAsked = new Set<number>();
  aiVoteAsked = new Set<number>();
  aiQuizAsked = new Set<number>();
  aiDiscussionAsked = new Set<number>();
  /** AI 主动私信：每个 AI 每轮讨论最多一次 */
  whisperAsked = new Set<number>();
  /** 推荐回复：key = phase:round:seat，避免重复生成 */
  suggestAsked = new Set<string>();
  /** 待向量化的公共事件批次（embedding 槽位未绑定时静默丢弃） */
  embedQueue: Array<{ seq: string; text: string }> = [];
  unlimitedHumanTurns = true;
  /** ★ 回合执行器 ★：同一时刻至多一个正式回合（AI 发言/DM 旁白）在锁外生成 */
  turnInFlight = false;
  turnToken = 0;
  /** 当前锁外生成；阶段/回合边界变化时由 continueTick 取消。 */
  activeAbortController: AbortController | null = null;
  activeGenerationBoundary: { phase: GameState["phase"]; round: number; turnSeat: number | null } | null = null;
  /** 轮次边界计数与上次摘要所处的边界（控制摘要更新频率，见 social.maybeScheduleSummarize） */
  summaryBoundaries = 0;
  lastSummaryBoundary = Number.NEGATIVE_INFINITY;
  /** 终局结算是否已落库（幂等标记） */
  endFinalized = false;

  private busy = false;
  /** 终局收尾失败后的自动重试次数（成功推进后归零） */
  private revealRetries = 0;
  private exclusiveTail: Promise<unknown> = Promise.resolve();

  private constructor(gameId: string, script: ScriptDocV2, state: GameState, events: EngineEvent[], unlimitedHumanTurns = true) {
    this.gameId = gameId;
    this.script = script;
    this.state = state;
    this.events = events;
    this.unlimitedHumanTurns = unlimitedHumanTurns;
    // 恢复已落事件、尚未落快照的幂等边界。
    for (const event of events) {
      if (event.type === "clue" && event.visibility === "public" && typeof event.content.clueId === "string") {
        const id = event.content.clueId;
        state.clueStates[id] = { discoveredBy: state.clueStates[id]?.discoveredBy ?? event.fromSeat, isPublic: true };
        for (const key of Object.keys(state.pendingPublish)) state.pendingPublish[key] = state.pendingPublish[key].filter((clueId) => clueId !== id);
      }
      if (event.type === "interaction" && typeof event.content.beatId === "string") {
        state.interactionChoices ??= {};
        state.interactionChoices[event.content.beatId] = { seatIndex: event.fromSeat ?? -1, choiceId: String(event.content.choiceId ?? ""), round: event.round, skipped: event.content.skipped === true };
        if (state.pendingInteraction?.beatId === event.content.beatId) state.pendingInteraction = null;
      }
      if (event.content.answer && event.content.questionId === state.pendingAnswer?.questionId) state.pendingAnswer = null;
    }
  }

  static get(gameId: string): GameEngine | undefined {
    return engines.get(gameId);
  }

  /** 从 DB 加载（已存在的对局，服务重启后恢复） */
  static async load(gameId: string): Promise<GameEngine> {
    const cached = engines.get(gameId);
    if (cached) return cached;
    const loading = engineLoads.get(gameId);
    if (loading) return loading;
    const promise = (async () => {
      const game = await db.game.findUnique({ where: { id: gameId }, include: { room: true } });
      if (!game) throw new Error("对局不存在");
      const scriptRow = await db.script.findUnique({ where: { id: game.scriptId } });
      if (!scriptRow) throw new Error("剧本不存在");
      // 只回放最近 EVENT_REPLAY_LIMIT 条：万条级历史全量进内存既拖慢恢复又无上下文价值
      // （完整事件流仍按需走 /events 的 DB 分页）。
      const [totalEvents, recentRows] = await db.$transaction([
        db.gameEvent.count({ where: { gameId } }),
        db.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "desc" }, take: EVENT_REPLAY_LIMIT }),
      ]);
      const eventRows = recentRows.slice().reverse();
      if (totalEvents > eventRows.length) {
        console.log(`[engine] ${gameId} 历史事件 ${totalEvents} 条，仅恢复最近 ${eventRows.length} 条`);
      }
      const events: EngineEvent[] = eventRows.map((r) => ({
        seq: r.seq.toString(),
        type: r.type as EngineEvent["type"],
        phase: r.phase as GameState["phase"],
        round: r.round,
        fromSeat: r.fromSeat,
        toSeat: r.toSeat,
        visibility: r.visibility,
        content: r.content as EngineEvent["content"],
        createdAt: r.createdAt.toISOString(),
      }));
      const state = (game.state as unknown as GameState | null) ?? initialState([]);
      // 兼容旧快照：缺字段补默认值
      state.pendingPublish ??= {};
      state.heldClues ??= {};
      state.searchChoices ??= {};
      state.votes ??= {};
      state.privateChat ??= {};
      state.readySeats ??= [];
      state.readingPromptedSeats ??= [];
      state.spokenSeats ??= [];
      state.searchDealtRound ??= 0;
      state.questionsLeft ??= {};
      state.pendingAnswer ??= null;
      state.humanDeadlines ??= {};
      state.actionPoints ??= {};
      state.usedSkills ??= [];
      state.quizAnswers ??= {};
      state.quizResult ??= null;
      state.unlockedSecrets ??= {};
      state.hostHandouts ??= {};
      state.guaranteeDeferUntil ??= {};
      state.hostHints ??= {};
      state.actionPlans ??= {};
      state.pendingInteraction ??= null;
      state.interactionChoices ??= {};
      if (state.pendingAnswer) state.pendingAnswer.questionId ??= `legacy:${gameId}:${state.round}:${state.pendingAnswer.fromSeat}:${state.pendingAnswer.toSeat}`;
      // 兼容曾被主持保证公开、却仍残留在待决策队列中的快照。
      // 玩家端不会为已公开线索显示“公开/私藏”按钮，若不清理会在搜证阶段死锁。
      for (const seat of Object.keys(state.pendingPublish)) {
        state.pendingPublish[seat] = (state.pendingPublish[seat] ?? []).filter((id) => !state.clueStates[id]?.isPublic);
      }
      // 旧快照可能没有这个字段：不补默认会让 `undefined++` 变成 NaN，
      // 而 `NaN >= 上限` 恒为假 → 该轮插话上限彻底失效。字段虽标 deprecated，但仍在读写。
      state.interjections ??= 0;
      // 服务重启后内存定时器已丢失，过期截止时间一并清掉，避免前端挂着永不跳转的倒计时
      for (const k of Object.keys(state.humanDeadlines)) {
        if (state.humanDeadlines[k] <= Date.now()) delete state.humanDeadlines[k];
      }
      const snapshot = game.scriptSnapshot ?? scriptRow.content;
      const engine = new GameEngine(gameId, parseScriptForRuntime(snapshot), state, events, game.room.unlimitedHumanTurns);
      rememberEngine(gameId, engine);
      engine.resumeAfterLoad();
      return engine;
    })();
    engineLoads.set(gameId, promise);
    try {
      return await promise;
    } finally {
      engineLoads.delete(gameId);
    }
  }

  /** 创建并开始一局（房间开局时调用） */
  static async start(room: Room & { seats: Seat[] }, scriptRow: { id: string; content: unknown }): Promise<GameEngine> {
    const script = parseScriptForRuntime(scriptRow.content);
    const seats: SeatInfo[] = room.seats
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ index: s.index, kind: s.kind as SeatInfo["kind"], characterId: s.characterId ?? "", playerName: s.playerName ?? `玩家${s.index + 1}` }));
    const state = initialState(seats);
    const normalizedSnapshot = script as unknown as object;
    const scriptHash = createHash("sha256").update(JSON.stringify(normalizedSnapshot)).digest("hex");
    const game = await db.game.create({
      data: {
        roomId: room.id,
        scriptId: scriptRow.id,
        status: "running",
        phase: "READING",
        round: 0,
        state: state as unknown as object,
        scriptSnapshot: normalizedSnapshot,
        scriptHash,
        scriptSnapshotSource: "start",
      },
    });
    await db.seatState
      .createMany({
        data: seats.filter((x) => x.kind !== "empty").map((s) => ({
          gameId: game.id,
          seatIndex: s.index,
          data: { clueIds: [], readScript: false },
        })),
      })
      .catch(async (err: unknown) => {
        // 老版本 Prisma/方言不支持 createMany 时退回逐条建（保持旧的容错语义）
        console.error(`[engine] seatState.createMany 失败，回落逐条创建：${String(err)}`);
        for (const s of seats.filter((x) => x.kind !== "empty")) {
          await db.seatState.create({ data: { gameId: game.id, seatIndex: s.index, data: { clueIds: [], readScript: false } } }).catch(() => null);
        }
      });
    const engine = new GameEngine(game.id, script, state, [], room.unlimitedHumanTurns);
    rememberEngine(game.id, engine);
    await beginGame(engine);
    return engine;
  }

  ctx(): AgentCtx {
    return { script: this.script, state: this.state, events: this.events, gameId: this.gameId };
  }

  /** 状态快照落库（所有功能域模块的统一出口） */
  async persist(): Promise<void> {
    await persistState(this.gameId, this.state);
  }

  /** 落库 + 总线广播 + 同步写回内存事件流（AI/DM 的 prompt 数据源必须是最新现场） */
  async recordEvent(ev: Omit<EngineEvent, "seq" | "createdAt"> & { content: Record<string, unknown> }): Promise<EngineEvent> {
    const event = await appendEvent(this.gameId, ev);
    this.events.push(event);
    queueEmbed(this, event);
    return event;
  }

  async systemSay(text: string, toSeat: number | null = null, extra?: Record<string, unknown>): Promise<void> {
    await this.recordEvent({
      type: "system",
      phase: this.state.phase,
      round: this.state.round,
      fromSeat: null,
      toSeat,
      visibility: toSeat === null ? "public" : `seat:${toSeat}`,
      content: { text, ...extra },
    });
  }

  /** 所有外部入口排队执行；内部请调 tickInner，不要再进 exclusive。 */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveTail.then(fn, fn);
    this.exclusiveTail = run.then(() => undefined, () => undefined);
    return run;
  }

  schedule(key: string, fn: () => void | Promise<void>, ms: number): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(key);
      // 显式 catch：不要依赖 exclusive 内部 then(fn, fn) 顺带吞掉 rejection，
      // 那样一旦 exclusive 重构就会变成 unhandled rejection 打崩进程。
      void this.exclusive(async () => {
        await fn();
      }).catch((err) => {
        console.error(`[engine] 定时任务 ${key} 失败:`, err);
      });
    }, ms);
    this.timers.set(key, t);
  }

  /** 慢速 AI 决策不能占用引擎互斥锁；完成后只把短暂状态提交重新排队。 */
  scheduleBackground(key: string, fn: () => void | Promise<void>, ms: number): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(key);
      void Promise.resolve(fn()).catch((err) => {
        void this.exclusive(() => this.systemSay(`（后台 AI 操作失败：${msgOf(err)}）`));
      });
    }, ms);
    this.timers.set(key, t);
  }

  /** 服务重启后重新挂定时器并推进：快照已恢复，内存定时器不会回来 */
  private resumeAfterLoad(): void {
    // 即使快照已经是 ENDED，也要经过一次 step：旧版本可能在持久化 ENDED 后
    // 因进程中断而漏写结束事件或房间结算。
    if (this.state.phase === "ENDED") {
      void this.exclusive(() => this.tickInner());
      return;
    }
    if (this.state.phase === "READING") {
      const ais = activeSeats(this.state).filter((i) => this.state.seats[i].kind === "ai" && !this.state.readySeats.includes(i));
      ais.forEach((seat, i) => {
        this.schedule(`ready:${seat}`, async () => {
          if (this.state.readySeats.includes(seat)) return;
          this.state.readySeats.push(seat);
          await this.persist();
          await this.tickInner();
        }, 800 + i * 400);
      });
    }
    if (
      this.state.phase === "SEARCH" &&
      this.state.searchDealtRound < this.state.round &&
      activeSeats(this.state).every((i) => this.state.searchChoices[String(i)]) &&
      Object.keys(this.state.clueStates).length > 0
    ) {
      this.state.searchDealtRound = this.state.round;
    }
    // 重启后重 arm 未过期的真人超时定时器（auto 回调已丢失，只能走跳过降级）
    for (const [k, deadline] of Object.entries(this.state.humanDeadlines ?? {})) {
      const seat = Number(k);
      if (!Number.isFinite(seat)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) continue;
      this.schedule(`human-turn:${seat}`, async () => {
        clearHumanTimeout(this, seat);
        await this.persist();
        await this.systemSay(
          `（你已超过 3 分钟未操作，本轮发言已自动跳过。）`,
          seat,
          { timeoutSkip: true }
        );
        await this.systemSay(
          `（超时提醒：等待「${this.state.seats[seat]?.playerName ?? `座位${seat + 1}`}」已超过 3 分钟，已自动跳过。）`
        );
        if (this.state.phase === "SELF_INTRO" || this.state.phase === "DISCUSSION") {
          this.markSpoken(seat);
          await this.nextTurnOrAdvance();
        } else {
          await this.tickInner();
        }
      }, remaining);
    }
    void this.exclusive(() => this.tickInner());
  }

  clearTimers(prefix?: string): void {
    for (const [key, t] of this.timers) {
      if (prefix === undefined || key.startsWith(prefix)) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
  }

  speakerName(seatIndex: number): string {
    const seat = this.state.seats[seatIndex];
    if (!seat) return `玩家${seatIndex + 1}`;
    const c = this.script.characters.find((ch) => ch.id === seat.characterId);
    return c?.name ?? seat.playerName;
  }

  // ============ 主驱动 ============

  /** 引擎心脏：根据当前状态推进下一步。外部入口走互斥队列。 */
  async tick(): Promise<void> {
    return this.exclusive(() => this.tickInner());
  }

  async tickInner(): Promise<void> {
    if (this.busy) {
      this.pendingTick = true;
      return;
    }
    this.busy = true;
    try {
      let iterations = 0;
      do {
        this.pendingTick = false;
        await this.step();
        iterations++;
      } while (this.pendingTick && iterations < 200 && this.state.phase !== "ENDED");
      if (iterations >= 200 && this.pendingTick && this.state.phase !== "ENDED") {
        console.error(`[engine] ${this.gameId} 单次 tick 连续推进达到 200 步，phase=${this.state.phase} round=${this.state.round}`);
      }
      this.revealRetries = 0;
    } catch (err) {
      // 内部调度错误只进入服务日志；玩家端不应看见“200 步”或数据库等实现细节。
      console.error(`[engine ${this.gameId}] tick failed: ${msgOf(err)}`);
      // REVEAL/ENDED 的收尾本应幂等重入，但触发下一次 tick 的来源只剩"玩家动作/重启"——
      // 给它一次定时兜底，避免终局卡在 REVEAL 只能靠真人点 nudge。上限 3 次防死循环。
      if ((this.state.phase === "REVEAL" || this.state.phase === "ENDED") && this.revealRetries < 3) {
        this.revealRetries++;
        this.schedule("reveal-retry", () => this.tickInner(), 5000);
      }
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    const state = this.state;
    const seats = activeSeats(state);
    switch (state.phase) {
      case "READING": {
        for (const seat of seats) {
          if (state.readySeats.includes(seat) || state.seats[seat]?.kind !== "human") continue;
          state.readingPromptedSeats ??= [];
          if (!state.readingPromptedSeats.includes(seat)) {
            state.readingPromptedSeats.push(seat);
            await this.persist();
            await this.systemSay(`请阅读角色剧本，完成后点击“我准备好了”；超时将自动进入下一阶段。`, seat);
          }
          await ensureHumanTimeout(this, seat, "读本确认");
        }
        if (seats.every((i) => state.readySeats.includes(i))) {
          this.clearTimers("ready:");
          await transitionSelfIntro(this);
        }
        return;
      }
      case "SELF_INTRO": {
        if (state.turnSeat === null) {
          if (state.round < this.script.flow.selfIntroRounds) {
            await advanceSelfIntroRound(this);
            return;
          }
          await transitionSearch(this, 1);
          return;
        }
        const seat = state.turnSeat;
        if (state.seats[seat]?.kind === "ai") {
          if (this.turnInFlight) return; // 回合在飞,提交回调会续跑
          dispatchPlayerSpeech(this, seat, { intro: true }, async () => {
            this.markSpoken(seat);
            await this.nextTurnOrAdvance({ tick: false });
          });
        } else {
          const askKey = `ask:${state.phase}:${state.round}:${seat}`;
          const firstPrompt = !this.turnAsked.has(askKey);
          if (firstPrompt) this.turnAsked.add(askKey);
          // 以「截止时间是否存在」为准重新武装，而不是「是否已提示过」——
          // 提问会清掉提问者的定时器，只认记忆位会让限时模式永久停在讨论环节。
          await ensureHumanTimeout(this, seat, "自我介绍");
          if (firstPrompt) {
            await this.systemSay(`轮到你自我介绍了。请在输入框发言，或点击"跳过"。`, seat);
            queueSuggestReply(this, seat);
          }
        }
        return;
      }
      case "SEARCH": {
        const missing = seats.filter((i) => !state.searchChoices[String(i)]);
        if (missing.length) {
          let autoCompleted = false;
          for (const seat of missing) {
            if (availableLocations(this, seat).length === 0) {
              this.state.searchChoices[String(seat)] = NO_SEARCH_CHOICE;
              autoCompleted = true;
              await this.systemSay("本轮没有可搜的线索材料，系统已自动完成搜证，将进入下一环节。", seat);
              continue;
            }
            if (state.seats[seat].kind === "ai") {
              queueAiSearchChoice(this, seat);
            } else if (!this.searchAsked.has(seat)) {
              this.searchAsked.add(seat);
              await armHumanTimeout(this, seat, "选搜证地点", async () => {
                if (this.state.searchChoices[String(seat)]) return;
                const locs = fallbackLocations(this, seat);
                const loc = locs[Math.floor(Math.random() * locs.length)] ?? this.script.locations[0]?.name ?? "";
                this.state.searchChoices[String(seat)] = loc;
                await this.systemSay(`（系统已代为选择「${loc}」。）`, seat);
                await this.persist();
                await this.tickInner();
              });
              await this.systemSay(`轮到你搜证：请在左侧选择一个地点。`, seat);
            }
          }
          await this.persist();
          // 自动结掉的位置不会带来任何"玩家动作"，也就没人再 tick 一次；
          // 全员同时耗尽时（线索数 < 人数×轮数的硬核本末轮）本步一 return，
          // 对局就永远停在"搜证·第 N 轮"，而文案已经承诺"将进入下一环节"。
          if (autoCompleted && seats.every((i) => this.state.searchChoices[String(i)])) this.pendingTick = true;
          return;
        }
        // 所有人已选 → 分派线索（每轮只发一次）
        if (this.state.searchDealtRound !== this.state.round) {
          await dispatchClues(this);
          this.state.searchDealtRound = this.state.round;
        }
        await collectPublishDecisions(this);
        if (Object.values(this.state.pendingPublish).some((arr) => arr.length)) {
          await this.persist();
          return; // 等人类决定
        }
        await finalizeSearchRound(this);
        return;
      }
      case "DISCUSSION": {
        ensureDiscussionState(state);
        if (state.pendingAnswer) {
          await resolvePendingAnswer(this);
          return;
        }
        if (state.turnSeat === null) {
          if (await runInteractionBeats(this)) return;
          const next = nextAfterDiscussion(state.round, this.script.flow.searchRounds, this.script.flow.discussionRounds);
          if (next === "SEARCH") await transitionSearch(this, state.round + 1);
          else if (next === "DISCUSSION") await transitionDiscussion(this, state.round + 1);
          else await transitionVote(this);
          return;
        }
        const seat = state.turnSeat;
        if (state.seats[seat]?.kind === "ai") {
          await runAiDiscussionTurn(this, seat);
        } else {
          const askKey = `ask:${state.phase}:${state.round}:${seat}`;
          const firstPrompt = !this.turnAsked.has(askKey);
          if (firstPrompt) this.turnAsked.add(askKey);
          // 同上：提问（ask / use_skill 质询 / skip 作答）都会清掉提问者的截止时间，
          // 回到提问者回合时必须重新武装，否则对方作答后该座位挂机就再也没人跳过它。
          await ensureHumanTimeout(this, seat, "圆桌发言");
          if (firstPrompt) {
            const left = state.questionsLeft[String(seat)] ?? 0;
            await this.systemSay(`轮到你发言。你可以当众陈述，也可以提问（剩余 ${left} 次）。结束后请点「结束发言」。`, seat);
            queueSuggestReply(this, seat);
          }
        }
        return;
      }
      case "REVEAL":
        // 终局收尾曾在中途失败(如 DB 抖动):重入幂等收尾,而不是永久停在 REVEAL
        await finishReveal(this);
        return;
      case "ENDED":
        await finalizeEnded(this);
        return;
      case "VOTE": {
        const voteMode = this.script.flow.voteMode;
        const hasQuiz = this.script.ending.quiz.length > 0;
        const missing = finaleMissing(state, { voteMode, seats, hasQuiz });
        if (!missing.votes.length && !missing.quiz.length) {
          await transitionReveal(this);
          return;
        }
        // AI：投票与答题各自后台决策（锁外 LLM）
        for (const seat of missing.votes) {
          if (state.seats[seat].kind === "ai") {
            const candidates = seats.filter((i) => i !== seat);
            queueAiVote(this, seat, candidates);
          }
        }
        for (const seat of missing.quiz) {
          if (state.seats[seat].kind === "ai") queueAiQuiz(this, seat);
        }
        // 人类：投票+答题共用一个限时；某项完成后 step 会按剩余项重新武装
        const humanPending = [...new Set([...missing.votes, ...missing.quiz])].filter((i) => state.seats[i].kind === "human");
        for (const seat of humanPending) {
          if (!this.turnAsked.has(`ask:VOTE:${seat}`)) {
            this.turnAsked.add(`ask:VOTE:${seat}`);
            await armVotePhaseHuman(this, seat);
          }
        }
        await this.persist();
        return;
      }
      default:
        return;
    }
  }

  markSpoken(seat: number): void {
    if (!this.state.spokenSeats.includes(seat)) this.state.spokenSeats.push(seat);
  }

  async nextTurnOrAdvance(opts?: { tick?: boolean }): Promise<void> {
    const seats = activeSeats(this.state);
    const unspoken = seats.filter((i) => !this.state.spokenSeats.includes(i));
    if (unspoken.length) {
      this.state.turnSeat = unspoken[0];
    } else {
      this.state.turnSeat = null;
    }
    await this.persist();
    // AI 发言的提交回调里不能立刻推进：dispatchTurn 还要按字数留阅读时间。
    if (opts?.tick !== false) this.continueTick();
  }

  /** 已在 tick 内则记 pending；否则等当前互斥释放后再推进，避免挡住 HTTP。 */
  continueTick(): void {
    if (this.turnInFlight && this.activeAbortController && this.activeGenerationBoundary) {
      const boundary = this.activeGenerationBoundary;
      if (boundary.phase !== this.state.phase || boundary.round !== this.state.round || boundary.turnSeat !== this.state.turnSeat) {
        this.activeAbortController.abort();
      }
    }
    if (this.busy) {
      this.pendingTick = true;
      return;
    }
    setImmediate(() => {
      if (this.busy) {
        this.pendingTick = true;
        return;
      }
      void this.tick();
    });
  }

  // ============ 真人动作入口 ============

  async handleAction(seatIndex: number, action: GameAction): Promise<{ ok: boolean; error?: string }> {
    const result = await this.exclusive(() => this.handleActionInner(seatIndex, action));
    if (result.ok) this.continueTick();
    return result;
  }

  private async handleActionInner(seatIndex: number, action: GameAction): Promise<{ ok: boolean; error?: string }> {
    if (this.state.phase === "ENDED") return { ok: false, error: "对局已结束" };
    const seat = this.state.seats[seatIndex];
    if (!seat || seat.kind !== "human") return { ok: false, error: "无权操作该座位" };
    switch (action.type) {
      case "interaction":
        return chooseInteraction(this, seatIndex, action.beatId ?? "", action.choiceId ?? "");
      case "ready": {
        if (this.state.phase !== "READING") return { ok: false, error: "当前不在读本环节" };
        clearHumanTimeout(this, seatIndex);
        if (!this.state.readySeats.includes(seatIndex)) this.state.readySeats.push(seatIndex);
        await this.systemSay("你已确认读完剧本。", seatIndex);
        await this.persist();
        this.continueTick();
        return { ok: true };
      }
      case "speak": {
        const text = (action.text ?? "").trim().slice(0, 800);
        if (!text) return { ok: false, error: "发言不能为空" };
        if (this.state.phase === "SELF_INTRO") {
          if (this.state.turnSeat !== seatIndex) return { ok: false, error: "现在不是你的发言回合" };
          await this.recordEvent({
            type: "speech",
            phase: this.state.phase,
            round: this.state.round,
            fromSeat: seatIndex,
            toSeat: null,
            visibility: "public",
            content: { text, speakerName: this.speakerName(seatIndex) },
          });
          clearSuggestions(this, seatIndex);
          clearHumanTimeout(this, seatIndex);
          this.markSpoken(seatIndex);
          await this.nextTurnOrAdvance();
          return { ok: true };
        }
        if (this.state.phase === "DISCUSSION") {
          if (this.state.pendingAnswer?.toSeat === seatIndex) {
            await this.recordEvent({
              type: "speech",
              phase: this.state.phase,
              round: this.state.round,
              fromSeat: seatIndex,
              toSeat: this.state.pendingAnswer.fromSeat,
              visibility: "public",
              content: { text, speakerName: this.speakerName(seatIndex), answer: true, questionId: this.state.pendingAnswer.questionId },
            });
            clearHumanTimeout(this, seatIndex);
            this.state.pendingAnswer = null;
            await this.persist();
            return { ok: true };
          }
          if (this.state.turnSeat !== seatIndex) return { ok: false, error: "现在不是你的发言回合" };
          if (this.state.pendingAnswer) return { ok: false, error: "请先等待对方回答你的提问" };
          await this.recordEvent({
            type: "speech",
            phase: this.state.phase,
            round: this.state.round,
            fromSeat: seatIndex,
            toSeat: null,
            visibility: "public",
            content: { text, speakerName: this.speakerName(seatIndex) },
          });
          clearSuggestions(this, seatIndex);
          await this.persist();
          // 点名了某位 AI → 对方可以立即简短插话回应（不占回合）
          maybeQueueInterjection(this, seatIndex, text);
          return { ok: true };
        }
        return { ok: false, error: "当前不能自由发言" };
      }
      case "ask": {
        return submitQuestion(this, seatIndex, action.toSeat ?? -1, action.text ?? "", action.evidenceIds);
      }
      case "skip": {
        if (this.state.phase !== "SELF_INTRO" && this.state.phase !== "DISCUSSION") {
          return { ok: false, error: "当前没有可跳过的发言回合" };
        }
        if (this.state.phase === "DISCUSSION" && this.state.pendingAnswer) {
          if (this.state.pendingAnswer.toSeat === seatIndex) {
            clearHumanTimeout(this, seatIndex);
            await this.systemSay("（你拒绝回答这个问题。）");
            this.state.pendingAnswer = null;
            await this.persist();
            this.continueTick();
            return { ok: true };
          }
          return { ok: false, error: "请先等待对方回答" };
        }
        if (this.state.turnSeat !== seatIndex) return { ok: false, error: "现在还没轮到你发言" };
        clearHumanTimeout(this, seatIndex);
        clearSuggestions(this, seatIndex);
        this.markSpoken(seatIndex);
        await this.systemSay("（你结束了本轮发言。）", seatIndex);
        await this.nextTurnOrAdvance();
        return { ok: true };
      }
      case "choose_location": {
        if (this.state.phase !== "SEARCH") return { ok: false, error: "当前不在搜证环节" };
        const chosen = this.state.searchChoices[String(seatIndex)];
        if (chosen) {
          // 哨兵值代表"本轮已无可搜、系统自动跳过"，与玩家主动选过地点是两回事，文案必须可区分
          return { ok: false, error: chosen === NO_SEARCH_CHOICE ? "本轮已无可搜地点，系统已自动完成搜证，无需选择" : "本轮已经选过地点" };
        }
        const loc = resolveLocation(this.script, action.location ?? "");
        if (!loc) return { ok: false, error: "地点不合法" };
        if (loc.ownerCharacterId === seatCharacterId(this, seatIndex)) {
          return { ok: false, error: "你不能搜自己的房间" };
        }
        if (!availableLocations(this, seatIndex).includes(loc.name) || cluesAt(this, loc.name, seatIndex).length === 0) {
          return { ok: false, error: `「${loc.name}」的线索已搜完，请选择其他地点` };
        }
        this.state.searchChoices[String(seatIndex)] = loc.name;
        clearHumanTimeout(this, seatIndex);
        await this.systemSay(`你选择了「${loc.name}」搜证。`, seatIndex);
        await this.persist();
        this.continueTick();
        return { ok: true };
      }
      case "publish": {
        if (this.state.phase !== "SEARCH") return { ok: false, error: "当前不在搜证环节" };
        const clueId = action.clueId ?? "";
        const held = (this.state.heldClues[seatIndex] ?? []).includes(clueId);
        if (!held) return { ok: false, error: "你没有这张线索卡" };
        const pending = this.state.pendingPublish[String(seatIndex)] ?? [];
        if (!pending.includes(clueId)) return { ok: false, error: "当前不能公开或私藏这张卡" };
        const clue = this.script.clues.find((c) => c.id === clueId);
        if (clue?.policy === "keep_private" && action.publish) return { ok: false, error: "该线索必须私藏" };
        await applyPublish(this, seatIndex, clueId, action.publish ?? false);
        this.state.pendingPublish[String(seatIndex)] = pending.filter((id) => id !== clueId);
        if (this.state.pendingPublish[String(seatIndex)]?.length === 0) this.clearTimers(`pub:${seatIndex}`);
        await this.persist();
        this.continueTick();
        return { ok: true };
      }
      case "vote": {
        if (this.state.phase !== "VOTE") return { ok: false, error: "当前不在投票环节" };
        if (this.script.flow.voteMode === "choice") return { ok: false, error: "本局为复盘答题模式，无需投票" };
        if (this.state.votes[String(seatIndex)]) return { ok: false, error: "本轮已经投过票" };
        const target = action.target;
        if (target === undefined || !activeSeats(this.state).includes(target)) return { ok: false, error: "投票对象不合法" };
        if (target === seatIndex) return { ok: false, error: "不能投自己" };
        const evidenceError = validateVoteEvidence(this.script.clues, this.state.clueStates, action.evidenceIds);
        if (evidenceError) return { ok: false, error: evidenceError };
        await recordVote(this, seatIndex, target, (action.reason ?? "").slice(0, 120) || undefined, action.evidenceIds);
        clearHumanTimeout(this, seatIndex);
        // hybrid：投票后可能还差答题，允许 step 重新武装剩余限时
        this.turnAsked.delete(`ask:VOTE:${seatIndex}`);
        this.continueTick();
        return { ok: true };
      }
      case "answer_quiz": {
        // ★ 复盘答题 ★：choice/hybrid 模式整卷一次性提交，提交后锁定。
        if (this.state.phase !== "VOTE") return { ok: false, error: "当前不在投票/复盘环节" };
        if (this.script.flow.voteMode === "culprit") return { ok: false, error: "本局没有复盘答题" };
        const questions = this.script.ending.quiz;
        if (!questions.length) return { ok: false, error: "本局没有复盘答题" };
        if (this.state.quizAnswers?.[String(seatIndex)]) return { ok: false, error: "已作答，不能修改" };
        const answers = Array.isArray(action.answers) ? action.answers : [];
        const sheet: Record<string, string> = {};
        for (const a of answers) {
          const q = questions.find((qq) => qq.id === a?.questionId);
          if (!q) return { ok: false, error: `题目不存在：${a?.questionId ?? "?"}` };
          if (!q.options.some((o) => o.id === a.optionId)) return { ok: false, error: `选项不合法：${a.optionId ?? "?"}` };
          sheet[q.id] = a.optionId;
        }
        if (Object.keys(sheet).length !== questions.length) return { ok: false, error: "请答完全部题目后再整卷提交" };
        this.state.quizAnswers ??= {};
        this.state.quizAnswers[String(seatIndex)] = sheet;
        clearHumanTimeout(this, seatIndex);
        // hybrid：交卷后可能还差投票，允许 step 按剩余项重新武装
        this.turnAsked.delete(`ask:VOTE:${seatIndex}`);
        await this.systemSay("（你已提交复盘答题卡，等待其他人作答。）", seatIndex);
        await this.persist();
        this.continueTick();
        return { ok: true };
      }
      case "use_skill": {
        // ★ 技能卡·质询（verify）★：消耗行动点，强制目标 AI 当众正面回答。
        const skillId = action.skillId ?? "";
        const toSeat = action.toSeat;
        const text = (action.text ?? "").trim().slice(0, 200);
        const invalid = validateUseSkill(this.script, this.state, seatIndex, skillId, toSeat, text);
        if (invalid) return { ok: false, error: invalid };
        const skill = skillOf(this, seatIndex, skillId);
        if (!skill || toSeat === undefined) return { ok: false, error: "技能不可用" };
        this.state.actionPoints ??= {};
        this.state.actionPoints[String(seatIndex)] = (this.state.actionPoints[String(seatIndex)] ?? 0) - skill.cost;
        this.state.usedSkills ??= [];
        if (skill.once) this.state.usedSkills.push(`${seatIndex}:${skill.id}`);
        this.state.pendingAnswer = { questionId: randomUUID(), fromSeat: seatIndex, toSeat, question: text, forced: true };
        // 技能提问与普通提问一样，暂停提问者的回合超时；作答完成后由讨论推进重新武装。
        clearHumanTimeout(this, seatIndex);
        await this.recordEvent({
          type: "system",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: null,
          toSeat: null,
          visibility: "public",
          content: {
            text: `${this.speakerName(seatIndex)} 动用了技能【${skill.name}】，要求 ${this.speakerName(toSeat)} 当众正面回答：${text}`,
            skillId,
            questionId: this.state.pendingAnswer.questionId,
          },
        });
        await this.persist();
        return { ok: true };
      }
      case "transfer": {
        // ★ 线索转交 ★：讨论阶段把未公开的持有线索私下面交给其他座位，双方可见。
        const toSeat = action.toSeat;
        const clueId = action.clueId ?? "";
        if (toSeat === undefined) return { ok: false, error: "转交对象不合法" };
        const invalid = validateTransfer(this.script, this.state, seatIndex, clueId, toSeat);
        if (invalid) return { ok: false, error: invalid };
        const clue = this.script.clues.find((c) => c.id === clueId);
        if (!clue) return { ok: false, error: "你没有这张线索卡" };
        this.state.heldClues[seatIndex] = (this.state.heldClues[seatIndex] ?? []).filter((id) => id !== clueId);
        this.state.heldClues[toSeat] = [...(this.state.heldClues[toSeat] ?? []), clueId];
        await this.recordEvent({
          type: "transfer",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seatIndex,
          toSeat,
          visibility: `seat:${toSeat}`,
          content: {
            clueId,
            clueName: clue.name,
            clueContent: clueText(clue),
            text: `${this.speakerName(seatIndex)} 悄悄把一张线索卡交给了你。`,
          },
        });
        await syncSeatClueIds(this, seatIndex);
        await syncSeatClueIds(this, toSeat);
        await this.persist();
        return { ok: true };
      }
      case "private_chat": {
        // ★ AI 主动私信的回复通道 ★：只有当某位 AI 向你开过私信窗口时才能回复。
        if (!this.script.flow.allowPrivateChat) return { ok: false, error: "本局未开放私聊" };
        if (this.state.phase !== "DISCUSSION") return { ok: false, error: "当前不在讨论环节" };
        const toSeat = action.toSeat ?? -1;
        const target = this.state.seats[toSeat];
        if (!target || target.kind !== "ai") return { ok: false, error: "只能回复 AI 玩家的私信" };
        const key = `${toSeat}-${seatIndex}`;
        if ((this.state.privateChat[key] ?? 0) <= 0) return { ok: false, error: "对方没有向你发起私信" };
        const text = (action.text ?? "").trim().slice(0, 300);
        if (!text) return { ok: false, error: "回复不能为空" };
        // 消耗一次窗口额度（非一次性封口）：AI 再次私信可续，额度用尽即封口。
        this.state.privateChat[key] -= 1;
        await this.recordEvent({
          type: "private",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seatIndex,
          toSeat,
          visibility: `seat:${toSeat}`,
          content: { text },
        });
        await this.persist();
        queueAiPrivateReply(this, toSeat, seatIndex, text);
        return { ok: true };
      }
      case "rush": {
        this.continueTick();
        return { ok: true };
      }
      default:
        return { ok: false, error: "未知动作" };
    }
  }

  // ============ 真人 DM 动作入口 ============

  async handleDmAction(action: { type: "narrate" | "nudge" | "skip_turn" | "handout" | "hint" | "force_ready" | "abort_game"; text?: string; clueId?: string; hintIndex?: number; seatIndex?: number }): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(() => this.handleDmActionInner(action));
  }

  private async handleDmActionInner(action: { type: "narrate" | "nudge" | "skip_turn" | "handout" | "hint" | "force_ready" | "abort_game"; text?: string; clueId?: string; hintIndex?: number; seatIndex?: number }): Promise<{ ok: boolean; error?: string }> {
    if (this.state.phase === "ENDED") return { ok: false, error: "对局已结束" };
    switch (action.type) {
      case "force_ready": {
        if (this.state.phase !== "READING") return { ok: false, error: "当前不在读本环节" };
        const seat = action.seatIndex;
        if (seat === undefined || !activeSeats(this.state).includes(seat)) return { ok: false, error: "座位不存在" };
        if (!this.state.readySeats.includes(seat)) this.state.readySeats.push(seat);
        clearHumanTimeout(this, seat);
        await this.systemSay(`（真人 DM 已代座位${seat + 1}完成读本确认。）`, seat);
        await this.persist();
        this.continueTick();
        return { ok: true };
      }
      case "abort_game": {
        this.clearTimers();
        this.activeAbortController?.abort();
        this.state.phase = "ENDED";
        this.state.pendingAnswer = null;
        await this.systemSay(`（真人 DM 已中止本局，对局状态已封存。）`);
        await this.persist();
        await db.$transaction(async (tx) => {
          const ended = await tx.game.update({ where: { id: this.gameId }, data: { status: "aborted", endedAt: new Date() } });
          await tx.room.update({ where: { id: ended.roomId }, data: { status: "aborted" } });
        });
        return { ok: true };
      }
      case "narrate": {
        const text = (action.text ?? "").trim().slice(0, 500);
        if (!text) return { ok: false, error: "内容不能为空" };
        await this.recordEvent({
          type: "system",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: null,
          toSeat: null,
          visibility: "public",
          content: { text: `【真人DM】${text}` },
        });
        return { ok: true };
      }
      case "nudge": {
        this.continueTick();
        return { ok: true };
      }
      case "skip_turn": {
        if ((this.state.phase === "SELF_INTRO" || this.state.phase === "DISCUSSION") && this.state.turnSeat !== null) {
          const seat = this.state.turnSeat;
          this.markSpoken(seat);
          await this.systemSay(`（真人DM 跳过了本回合的发言。）`);
          await this.nextTurnOrAdvance();
        } else {
          this.continueTick();
        }
        return { ok: true };
      }
      case "handout": {
        const clueId = action.clueId?.trim();
        const clue = clueId ? this.script.clues.find((candidate) => candidate.id === clueId) : undefined;
        if (!clue) return { ok: false, error: "线索不存在" };
        if (clue.policy === "keep_private") return { ok: false, error: "该线索被作者标记为不可公开" };
        if (this.state.clueStates[clue.id]?.isPublic) return { ok: true };
        this.state.clueStates[clue.id] = { discoveredBy: this.state.clueStates[clue.id]?.discoveredBy ?? null, isPublic: true };
        this.state.hostHandouts ??= {};
        this.state.hostHandouts[clue.id] = { round: this.state.round, reason: "manual_dm" };
        await this.recordEvent({
          type: "clue",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: null,
          toSeat: null,
          visibility: "public",
          content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), hostRelease: true, manual: true },
        });
        await this.systemSay(`真人 DM 公开补发线索卡【${clue.name}】。`);
        await this.persist();
        return { ok: true };
      }
      case "hint": {
        const index = action.hintIndex;
        const hint = index === undefined ? undefined : this.script.hostGuide?.stallBreakers[index];
        if (!hint) return { ok: false, error: "主持提示不存在" };
        this.state.hostHints ??= {};
        const key = `${this.state.round}:${index}`;
        if (this.state.hostHints[key]) return { ok: true };
        this.state.hostHints[key] = { round: this.state.round, condition: hint.condition, hint: hint.hint };
        await this.systemSay(`【主持提示】${hint.hint}`);
        await this.persist();
        return { ok: true };
      }
      default:
        return { ok: false, error: "未知 DM 动作" };
    }
  }
}
