import { db } from "@/lib/db";
import type { Room, Seat } from "@prisma/client";
import { clueText, fullTimelineText, methodText, parseScriptForRuntime, resolveLocation, revealText, winText } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { publish } from "./bus";
import { activeSeats, appendEvent, initialState, persistState } from "./state";
import { nextAfterDiscussion, nextAfterSearch } from "./flow";
import type { EngineEvent, GameState, SeatInfo } from "./types";
import { agent, type AgentCtx } from "@/core/agents";

const g = globalThis as unknown as {
  __jbsEngines?: Map<string, GameEngine>;
  __jbsEngineLoads?: Map<string, Promise<GameEngine>>;
};
const engines = (g.__jbsEngines ??= new Map<string, GameEngine>());
const engineLoads = (g.__jbsEngineLoads ??= new Map<string, Promise<GameEngine>>());

const HUMAN_TURN_TIMEOUT_MS = 180_000;
const TYPEWRITER_CHUNK = 3;
const TYPEWRITER_INTERVAL_MS = 18;
const MAX_INTERJECTIONS_PER_ROUND = 3;
const AI_DECISION_TIMEOUT_MS = 90_000;

export interface GameAction {
  type: "ready" | "speak" | "skip" | "choose_location" | "publish" | "vote" | "private_chat" | "rush";
  text?: string;
  location?: string;
  clueId?: string;
  publish?: boolean;
  target?: number;
  reason?: string;
  toSeat?: number;
}

export class GameEngine {
  readonly gameId: string;
  script: ScriptDocV2;
  state: GameState;
  events: EngineEvent[] = [];
  private busy = false;
  private pendingTick = false;
  /** 键名化的定时器：ready:*  AI 读本；turn:* 人类回合超时；pub:* 公开决策超时 */
  private timers = new Map<string, NodeJS.Timeout>();
  private turnAsked = new Set<string>();
  private searchAsked = new Set<number>();
  private publishAsked = new Set<number>();
  private aiVoteAsked = new Set<number>();
  private unlimitedHumanTurns = true;

  private constructor(gameId: string, script: ScriptDocV2, state: GameState, events: EngineEvent[], unlimitedHumanTurns = true) {
    this.gameId = gameId;
    this.script = script;
    this.state = state;
    this.events = events;
    this.unlimitedHumanTurns = unlimitedHumanTurns;
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
      const eventRows = await db.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" } });
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
      state.spokenSeats ??= [];
      state.searchDealtRound ??= 0;
      const engine = new GameEngine(gameId, parseScriptForRuntime(scriptRow.content), state, events, game.room.unlimitedHumanTurns);
      engines.set(gameId, engine);
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
    const game = await db.game.create({
      data: { roomId: room.id, scriptId: scriptRow.id, status: "running", phase: "READING", round: 0, state: state as unknown as object },
    });
    for (const s of seats.filter((x) => x.kind !== "empty")) {
      await db.seatState.create({ data: { gameId: game.id, seatIndex: s.index, data: { clueIds: [], readScript: false } } }).catch(() => null);
    }
    const engine = new GameEngine(game.id, script, state, [], room.unlimitedHumanTurns);
    engines.set(game.id, engine);
    await engine.beginGame();
    return engine;
  }

  private ctx(): AgentCtx {
    return { script: this.script, state: this.state, events: this.events, gameId: this.gameId };
  }

  /** 落库 + 总线广播 + 同步写回内存事件流（AI/DM 的 prompt 数据源必须是最新现场） */
  private async recordEvent(ev: Omit<EngineEvent, "seq" | "createdAt"> & { content: Record<string, unknown> }): Promise<EngineEvent> {
    const event = await appendEvent(this.gameId, ev);
    this.events.push(event);
    return event;
  }

  private exclusiveTail: Promise<unknown> = Promise.resolve();

  /** 所有外部入口排队执行；内部请调 tickInner，不要再进 exclusive。 */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveTail.then(fn, fn);
    this.exclusiveTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private schedule(key: string, fn: () => void | Promise<void>, ms: number): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(key);
      void this.exclusive(async () => {
        await fn();
      });
    }, ms);
    this.timers.set(key, t);
  }

  /** 慢速 AI 决策不能占用引擎互斥锁；完成后只把短暂状态提交重新排队。 */
  private scheduleBackground(key: string, fn: () => void | Promise<void>, ms: number): void {
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
    if (this.state.phase === "ENDED") return;
    if (this.state.phase === "READING") {
      const ais = activeSeats(this.state).filter((i) => this.state.seats[i].kind === "ai" && !this.state.readySeats.includes(i));
      ais.forEach((seat, i) => {
        this.schedule(`ready:${seat}`, async () => {
          if (this.state.readySeats.includes(seat)) return;
          this.state.readySeats.push(seat);
          await persistState(this.gameId, this.state);
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
    void this.exclusive(() => this.tickInner());
  }

  private clearTimers(prefix?: string): void {
    for (const [key, t] of this.timers) {
      if (prefix === undefined || key.startsWith(prefix)) {
        clearTimeout(t);
        this.timers.delete(key);
      }
    }
  }

  private speakerName(seatIndex: number): string {
    const seat = this.state.seats[seatIndex];
    if (!seat) return `玩家${seatIndex + 1}`;
    const c = this.script.characters.find((ch) => ch.id === seat.characterId);
    return c?.name ?? seat.playerName;
  }

  /** 打字机效果：thinking → 分片 delta → 完成。audience 限定可见范围（私聊仅双方）。 */
  private async typewriter(seatIndex: number, text: string, audience: "public" | number = "public"): Promise<void> {
    publish(this.gameId, { kind: "thinking", seat: seatIndex, audience });
    for (let i = 0; i < text.length; i += TYPEWRITER_CHUNK) {
      publish(this.gameId, { kind: "delta", seat: seatIndex, text: text.slice(i, i + TYPEWRITER_CHUNK), audience });
      await new Promise((r) => setTimeout(r, TYPEWRITER_INTERVAL_MS));
    }
  }

  private async aiSpeak(seatIndex: number, opts: { intro?: boolean; hint?: string } = {}): Promise<void> {
    publish(this.gameId, { kind: "thinking", seat: seatIndex, audience: "public" });
    let text: string;
    try {
      text = await agent.playerSpeak(this.ctx(), seatIndex, opts);
    } catch (err) {
      await this.systemSay(`（AI 玩家「${this.speakerName(seatIndex)}」思考时遇到问题：${msgOf(err)}。场内玩家可稍作等待或继续。）`);
      publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
      return;
    }
    if (!text.trim()) {
      await this.systemSay(`（AI 玩家「${this.speakerName(seatIndex)}」没有组织出有效发言，先跳过。）`);
      publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
      return;
    }
    await this.typewriter(seatIndex, text);
    await this.recordEvent({
      type: "speech",
      phase: this.state.phase,
      round: this.state.round,
      fromSeat: seatIndex,
      toSeat: null,
      visibility: "public",
      content: { text, speakerName: this.speakerName(seatIndex) },
    });
  }

  private async dmSay(task: string, phase: GameState["phase"] = this.state.phase, round = this.state.round): Promise<string> {
    publish(this.gameId, { kind: "thinking", seat: "dm", audience: "public" });
    try {
      const text = await agent.dmNarrate(this.ctx(), task);
      await this.recordEvent({
        type: "phase",
        phase,
        round,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { text, phase, round },
      });
      return text;
    } catch {
      const fallback = `（主持人正在准备：${task}）`;
      await this.recordEvent({
        type: "phase",
        phase,
        round,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { text: fallback, phase, round },
      });
      return fallback;
    } finally {
      publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
    }
  }

  private async systemSay(text: string, toSeat: number | null = null): Promise<void> {
    await this.recordEvent({
      type: "system",
      phase: this.state.phase,
      round: this.state.round,
      fromSeat: null,
      toSeat,
      visibility: toSeat === null ? "public" : `seat:${toSeat}`,
      content: { text },
    });
  }

  // ============ 阶段流转 ============

  private async beginGame(): Promise<void> {
    this.state.phase = "READING";
    this.state.round = 0;
    await this.dmSay(
      `游戏开始。请宣布开场：介绍剧本《${this.script.meta.title}》的背景（可直接取用公开背景大意）、案件情况（${this.script.meta.title} 中的死者与发现经过），宣布进入【读本环节】：每位玩家请阅读自己的角色剧本，读完后点击"我准备好了"。`,
      "READING",
      0
    );
    await persistState(this.gameId, this.state);
    // AI 座位陆续"读完"
    const ais = activeSeats(this.state).filter((i) => this.state.seats[i].kind === "ai");
    ais.forEach((seat, i) => {
      this.schedule(`ready:${seat}`, async () => {
        if (this.state.readySeats.includes(seat)) return;
        this.state.readySeats.push(seat);
        await persistState(this.gameId, this.state);
        await this.tickInner();
      }, 5000 + i * 3500);
    });
  }

  private async transitionSelfIntro(): Promise<void> {
    this.state.phase = "SELF_INTRO";
    this.state.round = 1;
    this.state.spokenSeats = [];
    this.searchAsked.clear();
    this.turnAsked.clear();
    const first = activeSeats(this.state)[0];
    this.state.turnSeat = first;
    await this.dmSay("宣布进入【自我介绍】环节：请各位按座位顺序简要介绍自己与死者的关系、今晚的大致行踪。", "SELF_INTRO", 1);
    await persistState(this.gameId, this.state);
    await this.tickInner();
  }

  private async transitionSearch(round: number): Promise<void> {
    this.state.phase = "SEARCH";
    this.state.round = round;
    this.state.searchChoices = {};
    this.state.pendingPublish = {};
    this.state.searchDealtRound = 0;
    this.searchAsked.clear();
    this.publishAsked.clear();
    this.turnAsked.clear();
    await this.dmSay(
      `宣布进入【第 ${round} 轮搜证】：每位玩家选择一个地点进行搜证，找到的线索可以选择当场公开或私藏。轮次共 ${this.script.flow.searchRounds} 轮。`,
      "SEARCH",
      round
    );
    await persistState(this.gameId, this.state);
    await this.tickInner();
  }

  private async transitionDiscussion(round: number): Promise<void> {
    this.state.phase = "DISCUSSION";
    this.state.round = round;
    this.state.spokenSeats = [];
    this.state.interjections = 0;
    this.searchAsked.clear();
    this.turnAsked.clear();
    this.state.turnSeat = activeSeats(this.state)[0];
    await this.dmSay(
      `宣布进入【第 ${round} 轮圆桌讨论】：请大家结合刚搜到的线索自由讨论，质疑与自证。本轮按座位顺序每人至少发言一次，也可以随时插话。`,
      "DISCUSSION",
      round
    );
    await persistState(this.gameId, this.state);
    await this.tickInner();
  }

  private async transitionVote(): Promise<void> {
    this.state.phase = "VOTE";
    this.state.round = 1;
    this.state.votes = {};
    this.aiVoteAsked.clear();
    this.turnAsked.clear();
    this.state.turnSeat = activeSeats(this.state)[0];
    await this.dmSay(
      "讨论结束，宣布进入【投票】环节：请每位玩家指认你认为的真凶，并说明一句话理由。投票结束后将立即揭晓真相。",
      "VOTE",
      1
    );
    await persistState(this.gameId, this.state);
    await this.tickInner();
  }

  private async transitionReveal(): Promise<void> {
    if (this.state.voteResult) return; // 同步守卫：防真人投票与 tick 并发双触发
    const counts: Record<string, number> = {};
    for (const v of Object.values(this.state.votes)) counts[String(v.target)] = (counts[String(v.target)] ?? 0) + 1;
    const culpritSeat = this.state.seats.findIndex((s) => s.kind !== "empty" && s.characterId === this.script.truth.culpritId);
    let topSeat = -1;
    let topCount = -1;
    for (const [k, n] of Object.entries(counts)) {
      if (n > topCount) {
        topCount = n;
        topSeat = Number(k);
      }
    }
    this.state.voteResult = { counts, culpritSeat, caught: topSeat === culpritSeat };
    const caughtName = this.state.seats[culpritSeat] ? this.speakerName(culpritSeat) : "?";
    this.state.phase = "REVEAL";
    this.state.round = 0;
    await this.dmSay(
      `公布投票结果（${Object.entries(counts).map(([k, n]) => `座位${Number(k) + 1} 得 ${n} 票`).join("，") || "无人投票"}），然后宣布揭晓真相：凶手是 ${caughtName}。请完整宣读真相复盘：手法、完整时间线、关键证据链，以及点评各位玩家今晚的表现（谁误导了大家、谁的推理最接近真相）。`,
      "REVEAL",
      0
    );
    await this.recordEvent({
      type: "reveal",
      phase: "REVEAL",
      round: 0,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { culpritSeat, culpritName: caughtName, caught: this.state.voteResult.caught, counts, method: methodText(this.script), fullTimeline: fullTimelineText(this.script), reveal: revealText(this.script), winText: winText(this.script) },
    });
    this.state.phase = "ENDED";
    await this.recordEvent({
      type: "phase",
      phase: "ENDED",
      round: 0,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { phase: "ENDED", round: 0, text: "" },
    });
    await persistState(this.gameId, this.state);
    await db.game.update({ where: { id: this.gameId }, data: { status: "ended", endedAt: new Date() } });
    publish(this.gameId, { kind: "end" });
  }

  // ============ 主驱动 ============

  /** 引擎心脏：根据当前状态推进下一步。外部入口走互斥队列。 */
  async tick(): Promise<void> {
    return this.exclusive(() => this.tickInner());
  }

  private async tickInner(): Promise<void> {
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
      if (iterations >= 200) {
        await this.systemSay("（引擎连续推进超过 200 步，已暂停以防失控。请稍后重试。）").catch(() => null);
      }
    } catch (err) {
      await this.systemSay(`（引擎遇到问题：${msgOf(err)}。你可以稍后重试或继续操作。）`).catch(() => null);
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    const state = this.state;
    const seats = activeSeats(state);
    switch (state.phase) {
      case "READING": {
        if (seats.every((i) => state.readySeats.includes(i))) {
          this.clearTimers("ready:");
          await this.transitionSelfIntro();
        }
        return;
      }
      case "SELF_INTRO": {
        if (state.turnSeat === null) {
          await this.transitionSearch(1);
          return;
        }
        const seat = state.turnSeat;
        if (state.seats[seat]?.kind === "ai") {
          await this.aiSpeak(seat, { intro: true });
          this.markSpoken(seat);
          await this.nextTurnOrAdvance();
        } else {
          const askKey = `ask:${state.phase}:${state.round}:${seat}`;
          if (!this.turnAsked.has(askKey)) {
            this.turnAsked.add(askKey);
            this.armHumanTimeout(seat, "自我介绍");
            await this.systemSay(`轮到你自我介绍了。请在输入框发言，或点击"跳过"。`, seat);
          }
        }
        return;
      }
      case "SEARCH": {
        const missing = seats.filter((i) => !state.searchChoices[String(i)]);
        if (missing.length) {
          for (const seat of missing) {
            if (state.seats[seat].kind === "ai") {
              this.queueAiSearchChoice(seat);
            } else if (!this.searchAsked.has(seat)) {
              this.searchAsked.add(seat);
              this.armHumanTimeout(seat, "选搜证地点", async () => {
                if (this.state.searchChoices[String(seat)]) return;
                const locs = this.availableLocations();
                const loc = locs[Math.floor(Math.random() * locs.length)] ?? this.script.locations[0]?.name ?? "";
                this.state.searchChoices[String(seat)] = loc;
                await this.systemSay(`（系统已代为选择「${loc}」。）`, seat);
                await persistState(this.gameId, this.state);
                await this.tickInner();
              });
              await this.systemSay(`轮到你搜证：请在左侧选择一个地点。`, seat);
            }
          }
          await persistState(this.gameId, state);
          return;
        }
        // 所有人已选 → 分派线索（每轮只发一次）
        if (this.state.searchDealtRound !== this.state.round) {
          await this.dispatchClues();
          this.state.searchDealtRound = this.state.round;
        }
        await this.collectPublishDecisions();
        if (Object.values(this.state.pendingPublish).some((arr) => arr.length)) {
          await persistState(this.gameId, state);
          return; // 等人类决定
        }
        await this.afterSearchPhase();
        return;
      }
      case "DISCUSSION": {
        if (state.turnSeat === null) {
          // 本轮讨论结束：SEARCH/DISCUSSION 交替，讨论轮用尽后进入投票
          const next = nextAfterDiscussion(state.round, this.script.flow.searchRounds, this.script.flow.discussionRounds);
          if (next === "SEARCH") await this.transitionSearch(state.round + 1);
          else if (next === "DISCUSSION") await this.transitionDiscussion(state.round + 1);
          else await this.transitionVote();
          return;
        }
        const seat = state.turnSeat;
        if (state.seats[seat]?.kind === "ai") {
          await this.aiSpeak(seat, { hint: `这是第 ${state.round} 轮讨论，请接续现场讨论或抛出你的质疑。` });
          this.markSpoken(seat);
          await this.nextTurnOrAdvance();
        } else {
          const askKey = `ask:${state.phase}:${state.round}:${seat}`;
          if (!this.turnAsked.has(askKey)) {
            this.turnAsked.add(askKey);
            this.armHumanTimeout(seat, "圆桌发言");
            await this.systemSay(`轮到你发言（第 ${state.round} 轮讨论）。`, seat);
          }
        }
        return;
      }
      case "VOTE": {
        const missing = seats.filter((i) => !state.votes[String(i)]);
        if (!missing.length) {
          await this.transitionReveal();
          return;
        }
        for (const seat of missing) {
          if (state.seats[seat].kind === "ai") {
            const candidates = seats.filter((i) => i !== seat);
            this.queueAiVote(seat, candidates);
          } else {
            const askKey = `ask:VOTE:${seat}`;
            if (!this.turnAsked.has(askKey)) {
              this.turnAsked.add(askKey);
              this.armHumanTimeout(seat, "投票", async () => {
                const candidates = activeSeats(this.state).filter((i) => i !== seat);
                const target = candidates[Math.floor(Math.random() * candidates.length)];
                if (this.state.votes[String(seat)]) return;
                await this.recordVote(seat, target, "（超时，系统代投）");
                if (activeSeats(this.state).every((i) => this.state.votes[String(i)])) {
                  await this.transitionReveal();
                } else {
                  await this.tickInner();
                }
              });
              await this.systemSay(`请投票：选择你认为的真凶（左侧玩家列表点击"投票"）。`, seat);
            }
          }
        }
        await persistState(this.gameId, state);
        if (seats.every((i) => state.votes[String(i)])) return this.step();
        return;
      }
      default:
        return;
    }
  }

  /** AI 选点放到互斥队列外的定时器里，避免卡住真人点击地点的 HTTP。 */
  private queueAiSearchChoice(seat: number): void {
    if (this.searchAsked.has(seat)) return;
    this.searchAsked.add(seat);
    this.scheduleBackground(`search-ai:${this.state.round}:${seat}`, async () => {
      if (this.state.phase !== "SEARCH") return;
      if (this.state.searchChoices[String(seat)]) return;
      const locations = this.availableLocations();
      let loc: string;
      try {
        loc = await withTimeout(agent.playerChooseLocation(this.ctx(), seat, locations), AI_DECISION_TIMEOUT_MS);
      } catch {
        loc = locations[Math.floor(Math.random() * locations.length)] ?? this.script.locations[0]?.name ?? "";
      }
      const resolved = resolveLocation(this.script, loc);
      if (!resolved) loc = locations[Math.floor(Math.random() * locations.length)] ?? this.script.locations[0]?.name ?? "";
      else if (locations.length > 0 && !locations.includes(resolved.name)) loc = locations[Math.floor(Math.random() * locations.length)] ?? "";
      if (!loc) return;
      await this.exclusive(async () => {
        if (this.state.phase !== "SEARCH" || this.state.searchChoices[String(seat)]) return;
        this.state.searchChoices[String(seat)] = loc;
        await this.systemSay(`你选择了「${loc}」搜证。`, seat);
        await persistState(this.gameId, this.state);
        await this.tickInner();
      });
    }, 50 + seat * 40);
  }

  private availableLocations(): string[] {
    return this.script.locations
      .filter((loc) => this.script.clues.some((c) => c.locationId === loc.id && this.state.clueStates[c.id] === undefined))
      .map((loc) => loc.name);
  }

  private queueAiVote(seat: number, candidates: number[]): void {
    if (this.aiVoteAsked.has(seat)) return;
    this.aiVoteAsked.add(seat);
    this.scheduleBackground(`vote-ai:${seat}`, async () => {
      let vote: { target: number; reason: string };
      try {
        vote = await withTimeout(agent.playerVote(this.ctx(), seat, candidates), AI_DECISION_TIMEOUT_MS);
      } catch {
        vote = { target: candidates[Math.floor(Math.random() * candidates.length)], reason: "" };
      }
      await this.exclusive(async () => {
        if (this.state.phase !== "VOTE" || this.state.votes[String(seat)]) return;
        const target = candidates.includes(vote.target) ? vote.target : candidates[0];
        if (target === undefined) return;
        await this.recordVote(seat, target, vote.reason);
        await this.tickInner();
      });
    }, 50 + seat * 40);
  }

  private cluesAt(locationKey: string) {
    const loc = resolveLocation(this.script, locationKey);
    if (!loc) return [];
    return this.script.clues.filter((c) => c.locationId === loc.id && this.state.clueStates[c.id] === undefined);
  }

  private async dispatchClues(): Promise<void> {
    for (const seat of activeSeats(this.state)) {
      const loc = this.state.searchChoices[String(seat)];
      if (!loc) continue;
      const candidates = this.cluesAt(loc);
      if (!candidates.length) {
        await this.systemSay(`你翻遍了「${loc}」，一无所获。`, seat);
        continue;
      }
      const clue = candidates[Math.floor(Math.random() * candidates.length)];
      const autoPublic = clue.policy === "auto_public";
      this.state.clueStates[clue.id] = { discoveredBy: seat, isPublic: autoPublic };
      this.state.heldClues[seat] = [...(this.state.heldClues[seat] ?? []), clue.id];
      await this.recordEvent({
        type: "clue",
        phase: this.state.phase,
        round: this.state.round,
        fromSeat: seat,
        toSeat: null,
        visibility: `seat:${seat}`,
        content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), location: loc, private: !autoPublic },
      });
      await this.systemSay(`你在「${loc}」搜到了线索卡【${clue.name}】。${autoPublic ? "该线索为公开线索，已向全场公示。" : "你可以选择当场公开或私藏。"}`, seat);
      if (autoPublic) {
        await this.recordEvent({
          type: "clue",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seat,
          toSeat: null,
          visibility: "public",
          content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), publicBy: seat },
        });
      } else if (clue.policy !== "keep_private") {
        this.state.pendingPublish[String(seat)] = [...(this.state.pendingPublish[String(seat)] ?? []), clue.id];
      }
    }
    // 更新 seatStates
    for (const seat of activeSeats(this.state)) {
      await db.seatState
        .upsert({
          where: { gameId_seatIndex: { gameId: this.gameId, seatIndex: seat } },
          create: { gameId: this.gameId, seatIndex: seat, data: { clueIds: this.state.heldClues[seat] ?? [] } },
          update: { data: { clueIds: this.state.heldClues[seat] ?? [] } },
        })
        .catch(() => null);
    }
  }

  private async collectPublishDecisions(): Promise<void> {
    for (const seatStr of Object.keys(this.state.pendingPublish)) {
      const seat = Number(seatStr);
      if (!(this.state.pendingPublish[seatStr] ?? []).length) continue;
      if (this.state.seats[seat]?.kind !== "ai") {
        if (!this.publishAsked.has(seat)) {
          this.publishAsked.add(seat);
          await this.systemSay(
            this.unlimitedHumanTurns
              ? `请决定：是否公开你刚获得的线索？（左侧"我的线索"中操作）`
              : `请决定：是否公开你刚获得的线索？（左侧"我的线索"中操作，超时将自动私藏）`,
            seat,
          );
          if (!this.unlimitedHumanTurns) {
            this.schedule(`pub:${seat}`, async () => {
              if (this.state.phase !== "SEARCH") return;
              const pending = this.state.pendingPublish[String(seat)] ?? [];
              if (!pending.length) return;
              for (const clueId of pending) await this.applyPublish(seat, clueId, false);
              this.state.pendingPublish[String(seat)] = [];
              await persistState(this.gameId, this.state);
              if (Object.values(this.state.pendingPublish).every((arr) => !arr.length)) {
                await this.afterSearchPhase();
              }
            }, HUMAN_TURN_TIMEOUT_MS);
          }
        }
        continue;
      }
      this.queueAiPublish(seat);
    }
  }

  private queueAiPublish(seat: number): void {
    if (this.publishAsked.has(seat)) return;
    this.publishAsked.add(seat);
    this.scheduleBackground(`pub-ai:${this.state.round}:${seat}`, async () => {
      if (this.state.phase !== "SEARCH") return;
      const clueIds = this.state.pendingPublish[String(seat)] ?? [];
      const decisions: Array<[string, boolean]> = [];
      for (const clueId of clueIds) {
        let publish = false;
        try {
          publish = await withTimeout(agent.playerChoosePublish(this.ctx(), seat, clueId), AI_DECISION_TIMEOUT_MS);
        } catch {
          publish = false;
        }
        decisions.push([clueId, publish]);
      }
      await this.exclusive(async () => {
        if (this.state.phase !== "SEARCH") return;
        for (const [clueId, publish] of decisions) {
          const pending = this.state.pendingPublish[String(seat)] ?? [];
          if (pending.includes(clueId)) await this.applyPublish(seat, clueId, publish);
        }
        this.state.pendingPublish[String(seat)] = [];
        await persistState(this.gameId, this.state);
        await this.tickInner();
      });
    }, 50 + seat * 40);
  }

  private async applyPublish(seat: number, clueId: string, publish: boolean): Promise<void> {
    const clue = this.script.clues.find((c) => c.id === clueId);
    if (!clue || this.state.clueStates[clueId]?.isPublic) return;
    if (publish && clue.policy === "keep_private") return;
    if (publish) {
      this.state.clueStates[clueId].isPublic = true;
      await this.recordEvent({
        type: "clue",
        phase: this.state.phase,
        round: this.state.round,
        fromSeat: seat,
        toSeat: null,
        visibility: "public",
        content: { clueId, clueName: clue.name, clueContent: clueText(clue), publicBy: seat },
      });
    } else {
      await this.systemSay(`你决定私藏线索【${clue.name}】。`, seat);
    }
  }

  private async afterSearchPhase(): Promise<void> {
    if (this.state.phase !== "SEARCH") return;
    const next = nextAfterSearch(this.state.round, this.script.flow.searchRounds, this.script.flow.discussionRounds);
    if (next === "DISCUSSION") await this.transitionDiscussion(this.state.round);
    else if (next === "SEARCH") await this.transitionSearch(this.state.round + 1);
    else await this.transitionVote();
  }

  private markSpoken(seat: number): void {
    if (!this.state.spokenSeats.includes(seat)) this.state.spokenSeats.push(seat);
  }

  private async nextTurnOrAdvance(): Promise<void> {
    const seats = activeSeats(this.state);
    const unspoken = seats.filter((i) => !this.state.spokenSeats.includes(i));
    if (unspoken.length) {
      this.state.turnSeat = unspoken[0];
    } else {
      this.state.turnSeat = null;
    }
    await persistState(this.gameId, this.state);
    this.continueTick();
  }

  /** 已在 tick 内则记 pending；否则等当前互斥释放后再推进，避免挡住 HTTP。 */
  private continueTick(): void {
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

  private armHumanTimeout(seat: number, label: string, auto?: () => Promise<void>): void {
    if (this.unlimitedHumanTurns) return;
    this.schedule(`turn:${seat}`, async () => {
      await this.systemSay(
        `（超时提醒：${label}环节等待「${this.state.seats[seat]?.playerName ?? `座位${seat + 1}`}」已超过 3 分钟${auto ? "，已自动处理。" : "，已自动跳过。"}）`
      );
      if (auto) {
        await auto();
        return;
      }
      if (this.state.phase === "SELF_INTRO" || this.state.phase === "DISCUSSION") {
        this.markSpoken(seat);
        await this.nextTurnOrAdvance();
      } else {
        await this.tickInner();
      }
    }, HUMAN_TURN_TIMEOUT_MS);
  }

  private async recordVote(seat: number, target: number, reason?: string): Promise<void> {
    this.state.votes[String(seat)] = { target, reason };
    await db.vote.create({ data: { gameId: this.gameId, seatIndex: seat, targetIndex: target, reason } }).catch(() => null);
    await this.recordEvent({
      type: "vote",
      phase: this.state.phase,
      round: this.state.round,
      fromSeat: seat,
      toSeat: null,
      visibility: "public",
      content: { target, reason, text: `${this.speakerName(seat)} 投给 ${this.speakerName(target)}${reason ? `：${reason}` : ""}` },
    });
    await persistState(this.gameId, this.state);
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
      case "ready": {
        if (this.state.phase !== "READING") return { ok: false, error: "当前不在读本环节" };
        if (!this.state.readySeats.includes(seatIndex)) this.state.readySeats.push(seatIndex);
        await this.systemSay("我已阅读完剧本。", seatIndex);
        await persistState(this.gameId, this.state);
        this.continueTick();
        return { ok: true };
      }
      case "speak": {
        const text = (action.text ?? "").trim().slice(0, 800);
        if (!text) return { ok: false, error: "发言不能为空" };
        await this.recordEvent({
          type: "speech",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seatIndex,
          toSeat: null,
          visibility: "public",
          content: { text, speakerName: this.speakerName(seatIndex) },
        });
        if (this.state.phase === "SELF_INTRO" && this.state.turnSeat === seatIndex) {
          this.clearTimers(`turn:${seatIndex}`);
          this.markSpoken(seatIndex);
          await this.nextTurnOrAdvance();
          return { ok: true };
        }
        if (this.state.phase === "DISCUSSION") {
          if (this.state.turnSeat === seatIndex) {
            this.clearTimers(`turn:${seatIndex}`);
            this.markSpoken(seatIndex);
            await this.nextTurnOrAdvance();
            return { ok: true };
          }
          // 插话：DM 评估 AI 接话
          if (this.state.interjections < MAX_INTERJECTIONS_PER_ROUND) {
            this.state.interjections += 1;
            let respond: number[] = [];
            let hint = "";
            publish(this.gameId, { kind: "thinking", seat: "dm", audience: "public" });
            try {
              const moderated = await agent.dmModerate(this.ctx(), seatIndex);
              respond = moderated.respond;
              hint = moderated.hint;
            } catch {
              // DM 不可用时不安排 AI 接话
            } finally {
              publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
            }
            for (const aiSeat of respond) {
              await this.aiSpeak(aiSeat, { hint: hint || undefined });
            }
          }
          await persistState(this.gameId, this.state);
          return { ok: true };
        }
        return { ok: true };
      }
      case "skip": {
        if (this.state.phase !== "SELF_INTRO" && this.state.phase !== "DISCUSSION") {
          return { ok: false, error: "当前没有可跳过的发言回合" };
        }
        if (this.state.turnSeat !== seatIndex) return { ok: false, error: "现在还没轮到你发言" };
        this.clearTimers(`turn:${seatIndex}`);
        this.markSpoken(seatIndex);
        await this.systemSay("（你跳过了本轮发言。）", seatIndex);
        await this.nextTurnOrAdvance();
        return { ok: true };
      }
      case "choose_location": {
        if (this.state.phase !== "SEARCH") return { ok: false, error: "当前不在搜证环节" };
        if (this.state.searchChoices[String(seatIndex)]) return { ok: false, error: "本轮已经选过地点" };
        const loc = resolveLocation(this.script, action.location ?? "");
        if (!loc) return { ok: false, error: "地点不合法" };
        if (this.availableLocations().length > 0 && this.cluesAt(loc.name).length === 0) {
          return { ok: false, error: `「${loc.name}」的线索已搜完，请选择其他地点` };
        }
        this.state.searchChoices[String(seatIndex)] = loc.name;
        this.clearTimers(`turn:${seatIndex}`);
        await this.systemSay(`你选择了「${loc.name}」搜证。`, seatIndex);
        await persistState(this.gameId, this.state);
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
        await this.applyPublish(seatIndex, clueId, action.publish ?? false);
        this.state.pendingPublish[String(seatIndex)] = pending.filter((id) => id !== clueId);
        if (this.state.pendingPublish[String(seatIndex)]?.length === 0) this.clearTimers(`pub:${seatIndex}`);
        await persistState(this.gameId, this.state);
        this.continueTick();
        return { ok: true };
      }
      case "vote": {
        if (this.state.phase !== "VOTE") return { ok: false, error: "当前不在投票环节" };
        if (this.state.votes[String(seatIndex)]) return { ok: false, error: "本轮已经投过票" };
        const target = action.target;
        if (target === undefined || !activeSeats(this.state).includes(target)) return { ok: false, error: "投票对象不合法" };
        if (target === seatIndex) return { ok: false, error: "不能投自己" };
        await this.recordVote(seatIndex, target, (action.reason ?? "").slice(0, 120) || undefined);
        this.clearTimers(`turn:${seatIndex}`);
        this.continueTick();
        return { ok: true };
      }
      case "private_chat": {
        if (!this.script.flow.allowPrivateChat || this.state.phase !== "DISCUSSION") return { ok: false, error: "当前无法私聊" };
        const toSeat = action.toSeat;
        if (toSeat === undefined || !activeSeats(this.state).includes(toSeat) || toSeat === seatIndex) return { ok: false, error: "私聊对象不合法" };
        const key = `${seatIndex}-${toSeat}`;
        const count = this.state.privateChat[key] ?? 0;
        if (count >= this.script.flow.privateChatMessageLimit) return { ok: false, error: "私聊条数已达上限" };
        this.state.privateChat[key] = count + 1;
        const text = (action.text ?? "").trim().slice(0, 300);
        if (!text) return { ok: false, error: "私聊内容不能为空" };
        await this.recordEvent({
          type: "private",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seatIndex,
          toSeat,
          visibility: `seat:${seatIndex}`,
          content: { text },
        });
        await this.recordEvent({
          type: "private",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seatIndex,
          toSeat,
          visibility: `seat:${toSeat}`,
          content: { text },
        });
        if (this.state.seats[toSeat].kind === "ai") {
          void (async () => {
            try {
              const reply = await agent.privateReply(this.ctx(), toSeat, seatIndex, text);
              await this.typewriter(toSeat, reply, seatIndex);
              await this.recordEvent({
                type: "private",
                phase: this.state.phase,
                round: this.state.round,
                fromSeat: toSeat,
                toSeat: seatIndex,
                visibility: `seat:${toSeat}`,
                content: { text: reply },
              });
              await this.recordEvent({
                type: "private",
                phase: this.state.phase,
                round: this.state.round,
                fromSeat: toSeat,
                toSeat: seatIndex,
                visibility: `seat:${seatIndex}`,
                content: { text: reply },
              });
            } catch (err) {
              await this.systemSay(`（私聊回复失败：${msgOf(err)}）`, seatIndex);
            }
          })();
        }
        await persistState(this.gameId, this.state);
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

  async handleDmAction(action: { type: "narrate" | "nudge" | "skip_turn"; text?: string }): Promise<{ ok: boolean; error?: string }> {
    return this.exclusive(() => this.handleDmActionInner(action));
  }

  private async handleDmActionInner(action: { type: "narrate" | "nudge" | "skip_turn"; text?: string }): Promise<{ ok: boolean; error?: string }> {
    if (this.state.phase === "ENDED") return { ok: false, error: "对局已结束" };
    switch (action.type) {
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
      default:
        return { ok: false, error: "未知 DM 动作" };
    }
  }
}

function msgOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("AI 决策超时")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
