import { runInteractionBeats } from "./interactions";
import { DM_ACTIONS, handleUnknownDmAction, PLAYER_ACTIONS, handleUnknownPlayerAction, type DmAction, type GameAction } from "./actions";
export type { GameAction } from "./actions";
import { db } from "@/lib/db";
import type { Room, Seat } from "@prisma/client";
import { parseScriptForRuntime } from "@/core/script/compat";
import { toPrismaJsonObject } from "@/lib/prisma-json";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import type { AgentCtx } from "@/core/agents";
import { activeSeats, appendEvent, initialState, persistState } from "./state";
import { migrateState } from "./state-migrate";
import { INSTANCE_ID, LeaseLostError, acquireLease, leaseOwner, startLeaseRenewal } from "./lease";
import { ensureDiscussionState, finaleMissing, nextAfterDiscussion } from "./flow";
import type { EngineEvent, GameState, SeatInfo } from "./types";
import { createHash } from "node:crypto";
import { engineLoads, engines, rememberEngine } from "./registry";
import { msgOf } from "./util";
import { log } from "@/lib/log";
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
import { queueEmbed, queueSuggestReply } from "./social";
import { armHumanTimeout, clearHumanTimeout, ensureHumanTimeout } from "./human-turn";
import {
  availableLocations,
  collectPublishDecisions,
  dispatchClues,
  finalizeSearchRound,
  fallbackLocations,
  NO_SEARCH_CHOICE,
  queueAiSearchChoice,
} from "./search-deal";
import { armVotePhaseHuman, queueAiQuiz, queueAiVote } from "./finale";
import { resolvePendingAnswer, runAiDiscussionTurn } from "./discussion";

/** 重启恢复时事件回放上限：只取最近 N 条，超长对局历史不进内存。 */
const EVENT_REPLAY_LIMIT = 800;
const LEASE_READ_ONLY_ERROR = "对局由其他实例主持，请刷新";

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
  /**
   * 本引擎代表哪个实例驱动（S4.1 单写者租约）。默认本进程的 `INSTANCE_ID`；
   * 显式传入别的 id 只用于 L3「同进程模拟另一实例」。
   */
  readonly ownerId: string;
  /**
   * 是否持有写租约。`false` = 只读视图：不 tick、不排定时器、动作一律拒绝，
   * 写出口抛 `LeaseLostError`。
   */
  drive = true;

  private busy = false;
  /** 只读视图的告警只记一次，避免每个被丢弃的入口都刷一行 */
  private leaseWarned = false;
  /** 终局收尾失败后的自动重试次数（成功推进后归零） */
  private revealRetries = 0;
  private exclusiveTail: Promise<unknown> = Promise.resolve();

  private constructor(gameId: string, script: ScriptDocV2, state: GameState, events: EngineEvent[], unlimitedHumanTurns = true, ownerId = INSTANCE_ID) {
    this.gameId = gameId;
    this.script = script;
    this.state = state;
    this.events = events;
    this.unlimitedHumanTurns = unlimitedHumanTurns;
    this.ownerId = ownerId;
    // 纵深防御：原子写启用后，正常情况下不会出现「事件已落、快照未落」；仍保留旧数据与异常现场的幂等修复。
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

  /**
   * 从 DB 加载（已存在的对局，服务重启后恢复）。
   * 拿到写租约才驱动；拿不到就返回只读视图，且**不进常驻表**——
   * 否则持有者放掉租约后，本实例会一直复用那个只读实例而再也接管不了。
   *
   * `opts.ownerId` 用于「同进程模拟另一实例」（L3 I08/I09），生产不传。
   */
  static async load(gameId: string, opts?: { ownerId?: string }): Promise<GameEngine> {
    const ownerId = opts?.ownerId ?? INSTANCE_ID;
    const cached = engines.get(gameId);
    if (cached && cached.ownerId === ownerId) return cached;
    const loadKey = ownerId === INSTANCE_ID ? gameId : `${gameId}|${ownerId}`;
    const loading = engineLoads.get(loadKey);
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
        log.info("[engine] 恢复历史事件窗口", { gameId, totalEvents, restoredEvents: eventRows.length });
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
      const state = migrateState(game.state, { now: Date.now(), gameId });
      const snapshot = game.scriptSnapshot ?? scriptRow.content;
      const engine = new GameEngine(gameId, parseScriptForRuntime(snapshot), state, events, game.room.unlimitedHumanTurns, ownerId);
      if (!(await acquireLease(gameId, ownerId))) {
        engine.drive = false;
        // R5 的判据要在实例日志里 grep 到 `lease held by`；日志只写 id，不含任何凭证。
        log.warn("[lease] 本实例只读（lease held by other instance）", { gameId, leaseOwner: await leaseOwner(gameId) });
        return engine;
      }
      rememberEngine(gameId, engine);
      startLeaseRenewal(gameId, () => engine.onLeaseLost(), ownerId);
      engine.resumeAfterLoad();
      return engine;
    })();
    engineLoads.set(loadKey, promise);
    try {
      return await promise;
    } finally {
      engineLoads.delete(loadKey);
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
    const normalizedSnapshot = toPrismaJsonObject(script);
    const scriptHash = createHash("sha256").update(JSON.stringify(normalizedSnapshot)).digest("hex");
    const game = await db.game.create({
      data: {
        roomId: room.id,
        scriptId: scriptRow.id,
        status: "running",
        phase: "READING",
        round: 0,
        state: toPrismaJsonObject(state),
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
        log.error("[engine] seatState.createMany 失败，回落逐条创建", { error: err });
        for (const s of seats.filter((x) => x.kind !== "empty")) {
          await db.seatState.create({ data: { gameId: game.id, seatIndex: s.index, data: { clueIds: [], readScript: false } } }).catch(() => null);
        }
      });
    const engine = new GameEngine(game.id, script, state, [], room.unlimitedHumanTurns);
    // 行是本次刚建的，正常一定拿得到；被并发开局抢先时退回只读，交给持牌实例驱动。
    if (!(await acquireLease(game.id))) {
      engine.drive = false;
      log.warn("[lease] 开局时由其他实例主持", { gameId: game.id, leaseOwner: await leaseOwner(game.id) });
      return engine;
    }
    rememberEngine(game.id, engine);
    startLeaseRenewal(game.id, () => engine.onLeaseLost());
    await beginGame(engine);
    return engine;
  }

  ctx(): AgentCtx {
    return { script: this.script, state: this.state, events: this.events, gameId: this.gameId };
  }

  /** 状态快照落库（所有功能域模块的统一出口） */
  async persist(): Promise<void> {
    this.assertNotLeaseLost();
    await persistState(this.gameId, this.state);
  }

  /** 落库 + 总线广播 + 同步写回内存事件流（AI/DM 的 prompt 数据源必须是最新现场） */
  async recordEvent(ev: Omit<EngineEvent, "seq" | "createdAt"> & { content: Record<string, unknown> }): Promise<EngineEvent> {
    this.assertNotLeaseLost();
    const event = await appendEvent(this.gameId, ev, this.state);
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

  /**
   * 续租失败 = 这一局已归别的实例主持。必须立刻停手：停自己的定时器、中止在途 AI 生成、
   * 把自己移出常驻表（下一次访问会重新争取租约）。写出口此后由 `assertNotLeaseLost` 拦住。
   */
  onLeaseLost(): void {
    if (!this.drive) return;
    this.drive = false;
    this.clearTimers();
    // 令号先加一再中止：在途的 AI 回合提交会因 token 不匹配被当作过期结果丢掉（见 turns.ts）。
    this.turnToken++;
    this.activeAbortController?.abort();
    engines.delete(this.gameId);
    log.warn("[lease] lease lost：租约已被其他实例接管，本实例停止驱动", { gameId: this.gameId });
  }

  /** 只读视图的一切写出口：抛错让当前步骤就地中止，别把状态写花。 */
  private assertNotLeaseLost(): void {
    if (this.drive) return;
    throw new LeaseLostError(this.gameId);
  }

  /** 只读视图被调到的驱动入口：放弃并留一行日志（同一引擎只记一次，避免刷屏）。 */
  private warnReadOnly(where: string): void {
    if (this.leaseWarned) return;
    this.leaseWarned = true;
    log.warn("[lease] 未持有租约，忽略写入动作", { gameId: this.gameId, operation: where });
  }

  schedule(key: string, fn: () => void | Promise<void>, ms: number): void {
    if (!this.drive) {
      this.warnReadOnly(`定时任务 ${key}`);
      return;
    }
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(key);
      // 显式 catch：不要依赖 exclusive 内部 then(fn, fn) 顺带吞掉 rejection，
      // 那样一旦 exclusive 重构就会变成 unhandled rejection 打崩进程。
      void this.exclusive(async () => {
        await fn();
      }).catch((err) => {
        log.error("[engine] 定时任务失败", { gameId: this.gameId, timerKey: key, error: err });
      });
    }, ms);
    this.timers.set(key, t);
  }

  /** 慢速 AI 决策不能占用引擎互斥锁；完成后只把短暂状态提交重新排队。 */
  scheduleBackground(key: string, fn: () => void | Promise<void>, ms: number): void {
    if (!this.drive) {
      this.warnReadOnly(`后台任务 ${key}`);
      return;
    }
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
    if (!this.drive) {
      this.warnReadOnly("tick");
      return;
    }
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
        log.error("[engine] 单次 tick 连续推进达到 200 步", { gameId: this.gameId, phase: this.state.phase, round: this.state.round });
      }
      this.revealRetries = 0;
    } catch (err) {
      // 内部调度错误只进入服务日志；玩家端不应看见“200 步”或数据库等实现细节。
      log.error("[engine] tick failed", { gameId: this.gameId, error: msgOf(err) });
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
    if (!this.drive) {
      this.warnReadOnly("回合推进");
      return;
    }
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
    if (!this.drive) return { ok: false, error: LEASE_READ_ONLY_ERROR };
    const result = await this.exclusive(() => this.handleActionInner(seatIndex, action));
    if (result.ok) this.continueTick();
    return result;
  }

  private async handleActionInner(seatIndex: number, action: GameAction): Promise<{ ok: boolean; error?: string }> {
    if (this.state.phase === "ENDED") return { ok: false, error: "对局已结束" };
    const seat = this.state.seats[seatIndex];
    if (!seat || seat.kind !== "human") return { ok: false, error: "无权操作该座位" };
    const handler = PLAYER_ACTIONS[action.type];
    return handler ? handler(this, seatIndex, action) : handleUnknownPlayerAction();
  }

  // ============ 真人 DM 动作入口 ============

  async handleDmAction(action: DmAction): Promise<{ ok: boolean; error?: string }> {
    if (!this.drive) return { ok: false, error: LEASE_READ_ONLY_ERROR };
    return this.exclusive(() => this.handleDmActionInner(action));
  }

  private async handleDmActionInner(action: DmAction): Promise<{ ok: boolean; error?: string }> {
    if (this.state.phase === "ENDED") return { ok: false, error: "对局已结束" };
    const handler = DM_ACTIONS[action.type];
    return handler ? handler(this, action) : handleUnknownDmAction();
  }
}
