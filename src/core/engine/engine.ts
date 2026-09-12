import { db } from "@/lib/db";
import type { Room, Seat } from "@prisma/client";
import { clueText, fullTimelineText, methodText, parseScriptForRuntime, resolveLocation, revealText, winText } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { publish } from "./bus";
import { activeSeats, appendEvent, initialState, persistState, renderEventLog, clueReachable } from "./state";
import { ensureDiscussionState, forcedAnswerHint, nextAfterDiscussion, nextAfterSearch, validateDiscussionAsk, validateTransfer, validateUseSkill, unlockedActs } from "./flow";
import type { EngineEvent, GameState, SeatInfo } from "./types";
import { agent, type AgentCtx } from "@/core/agents";
import { SUMMARY_TRIGGER_CHARS, pendingHeadChars, planMemorySplit } from "@/core/agents/memory";
import { MAX_INTERJECTIONS_PER_ROUND, mentionedAiSeats } from "@/core/agents/mention";
import { embedTexts } from "@/core/llm/client";

const g = globalThis as unknown as {
  __jbsEngines?: Map<string, GameEngine>;
  __jbsEngineLoads?: Map<string, Promise<GameEngine>>;
};
const engines = (g.__jbsEngines ??= new Map<string, GameEngine>());
const engineLoads = (g.__jbsEngineLoads ??= new Map<string, Promise<GameEngine>>());

const HUMAN_TURN_TIMEOUT_MS = 180_000;
const AI_DECISION_TIMEOUT_MS = 90_000;

export interface GameAction {
  type: "ready" | "speak" | "skip" | "ask" | "choose_location" | "publish" | "vote" | "private_chat" | "rush" | "transfer" | "use_skill";
  text?: string;
  location?: string;
  clueId?: string;
  skillId?: string;
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
  private aiDiscussionAsked = new Set<number>();
  /** AI 主动私信：每个 AI 每轮讨论最多一次 */
  private whisperAsked = new Set<number>();
  /** 推荐回复：key = phase:round:seat，避免重复生成 */
  private suggestAsked = new Set<string>();
  /** 待向量化的公共事件批次（embedding 槽位未绑定时静默丢弃） */
  private embedQueue: Array<{ seq: string; text: string }> = [];
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
      state.questionsLeft ??= {};
      state.pendingAnswer ??= null;
      state.humanDeadlines ??= {};
      state.actionPoints ??= {};
      state.usedSkills ??= [];
      // 服务重启后内存定时器已丢失，过期截止时间一并清掉，避免前端挂着永不跳转的倒计时
      for (const k of Object.keys(state.humanDeadlines)) {
        if (state.humanDeadlines[k] <= Date.now()) delete state.humanDeadlines[k];
      }
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
    this.maybeScheduleSummarize();
    this.queueEmbed(event);
    return event;
  }

  /**
   * ★ 向量检索记忆层·写入侧 ★：公开发言异步向量化入库（批量防抖）。
   * 检索候选只取发言，其余事件不写入，省 embedding 开销。
   * 未绑定 embedding 槽位时 embedTexts 返回 null，整层静默关闭。
   */
  private queueEmbed(event: EngineEvent): void {
    if (event.visibility !== "public" || event.type !== "speech") return;
    const text = String(event.content.text ?? "");
    if (!text.trim()) return;
    this.embedQueue.push({ seq: event.seq, text: `${this.speakerName(event.fromSeat ?? 0)}说：${text}`.slice(0, 512) });
    this.scheduleBackground("embed", async () => {
      const batch = this.embedQueue.splice(0, 8);
      if (!batch.length) return;
      const vectors = await embedTexts(batch.map((b) => b.text));
      if (!vectors) return; // embedding 未绑定或失败：静默降级
      for (let i = 0; i < batch.length; i++) {
        await db.eventVector
          .create({ data: { gameId: this.gameId, seq: BigInt(batch[i].seq), vector: vectors[i] } })
          .catch(() => null); // 重复写入等场景直接忽略
      }
    }, 1500);
  }

  /**
   * ★ mention 插话调度 ★：真人发言点名了某位 AI，该 AI 立即简短回应。
   * 不占用任何人的正式发言回合、不改 turnSeat；每轮讨论限 MAX_INTERJECTIONS_PER_ROUND 次。
   * 流式在互斥锁外进行，结束时短暂排队补记事件；阶段已离开讨论则丢弃。
   */
  private maybeQueueInterjection(fromSeat: number, text: string): void {
    if (this.state.phase !== "DISCUSSION") return;
    if (this.state.interjections >= MAX_INTERJECTIONS_PER_ROUND) return;
    const target = mentionedAiSeats(this.script, this.state, text, fromSeat)[0];
    if (target === undefined) return;
    this.scheduleBackground(`interject`, async () => {
      if (this.state.phase !== "DISCUSSION" || this.state.interjections >= MAX_INTERJECTIONS_PER_ROUND) return;
      await this.exclusive(async () => {
        if (this.state.phase !== "DISCUSSION" || this.state.interjections >= MAX_INTERJECTIONS_PER_ROUND) return;
        this.state.interjections++;
        await persistState(this.gameId, this.state);
      });
      const opts = {
        hint: `${this.speakerName(fromSeat)} 刚才点名提到了你：「${text.slice(0, 120)}」。请作为插话立即简短回应。`,
        extraInstruction:
          "这是一次插话（不占用你的正式发言回合）：一两句话（40-90字）自然接话，可以自证、反驳或带过；不要重复你之前说过的内容，不要替别人作答。",
      };
      let said = await this.consumeStream(
        () => agent.streamPlayerSpeech(this.ctx(), target, opts),
        (delta) => publish(this.gameId, { kind: "delta", seat: target, text: delta, audience: "public" }),
        AI_DECISION_TIMEOUT_MS
      );
      if (!said.trim()) {
        try {
          said = await withTimeout(agent.playerSpeak(this.ctx(), target, opts), AI_DECISION_TIMEOUT_MS);
        } catch {
          said = "";
        }
      }
      said = await agent.refineSpeech(this.ctx(), target, said);
      await this.exclusive(async () => {
        if (this.state.phase !== "DISCUSSION" || !said.trim()) return;
        await this.recordEvent({
          type: "speech",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: target,
          toSeat: fromSeat,
          visibility: "public",
          content: { text: said, speakerName: this.speakerName(target), interjection: true },
        });
      });
    }, 400);
  }

  /**
   * ★ AI 主动私聊 ★：AI 发言结束后可审慎决定悄悄私信一位真人玩家（每 AI 每轮一次）。
   * 私信事件 visibility 只给收件人；发送方凭 fromSeat 规则在自己上下文里看到自己说过的话。
   */
  private maybeQueueWhisper(seat: number): void {
    if (this.state.phase !== "DISCUSSION") return;
    if (this.whisperAsked.has(seat)) return;
    this.whisperAsked.add(seat);
    const humanSeats = activeSeats(this.state).filter((i) => this.state.seats[i].kind === "human" && i !== seat);
    if (!humanSeats.length) return;
    this.scheduleBackground(`whisper:${seat}`, async () => {
      let decision: { toSeat: number; text: string } | null = null;
      try {
        decision = await withTimeout(agent.playerConsiderWhisper(this.ctx(), seat, humanSeats), AI_DECISION_TIMEOUT_MS);
      } catch {
        decision = null;
      }
      if (!decision) return;
      await this.exclusive(async () => {
        if (this.state.phase !== "DISCUSSION") return;
        if (this.state.seats[decision.toSeat]?.kind !== "human") return;
        const key = `${seat}-${decision.toSeat}`;
        this.state.privateChat[key] = (this.state.privateChat[key] ?? 0) + 1;
        await this.recordEvent({
          type: "private",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seat,
          toSeat: decision.toSeat,
          visibility: `seat:${decision.toSeat}`,
          content: { text: decision.text },
        });
        await persistState(this.gameId, this.state);
      });
    }, 1200);
  }

  /** 真人回复 AI 私信后，AI 用原私聊口吻回一句（同样只双方可见）。 */
  private queueAiPrivateReply(aiSeat: number, humanSeat: number, message: string): void {
    this.scheduleBackground(`whisper-reply:${aiSeat}-${humanSeat}`, async () => {
      let reply = "";
      try {
        reply = await withTimeout(agent.privateReply(this.ctx(), aiSeat, humanSeat, message), AI_DECISION_TIMEOUT_MS);
      } catch {
        reply = "";
      }
      if (!reply.trim()) return;
      await this.exclusive(async () => {
        if (this.state.phase !== "DISCUSSION") return;
        await this.recordEvent({
          type: "private",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: aiSeat,
          toSeat: humanSeat,
          visibility: `seat:${humanSeat}`,
          content: { text: reply },
        });
      });
    }, 100);
  }

  /** ★ 推荐回复 ★：轮到真人发言时后台生成 3 条建议短句；发言/跳过后清除。 */
  private queueSuggestReply(seat: number): void {
    const key = `${this.state.phase}:${this.state.round}:${seat}`;
    if (this.suggestAsked.has(key)) return;
    this.suggestAsked.add(key);
    this.scheduleBackground(`suggest:${seat}`, async () => {
      let items: string[] = [];
      try {
        items = await withTimeout(agent.suggestReplies(this.ctx(), seat), AI_DECISION_TIMEOUT_MS);
      } catch {
        items = [];
      }
      if (!items.length) return;
      await this.exclusive(async () => {
        if (!this.state.suggestions) this.state.suggestions = {};
        this.state.suggestions[String(seat)] = items;
        await persistState(this.gameId, this.state);
      });
    }, 200);
  }

  private clearSuggestions(seat: number): void {
    if (this.state.suggestions) delete this.state.suggestions[String(seat)];
  }

  /**
   * ★ 分层记忆维护 ★：新增公共记录攒够一批（SUMMARY_TRIGGER_CHARS）就在后台滚动更新摘要。
   * 摘要更新在互斥锁外做 LLM 调用，完成后只把短暂的状态提交重新排队（同 AI 投票决策模式）。
   */
  private maybeScheduleSummarize(): void {
    if (this.state.phase === "REVEAL" || this.state.phase === "ENDED") return;
    const pending = pendingHeadChars(this.events, this.state.memory?.anchorSeq ?? "");
    if (pending < SUMMARY_TRIGGER_CHARS) return;
    this.scheduleBackground("memory", async () => {
      if (this.state.phase === "REVEAL" || this.state.phase === "ENDED") return;
      const { head } = planMemorySplit(this.events);
      const anchor = head[head.length - 1];
      if (!anchor || !isNewerSeq(anchor.seq, this.state.memory?.anchorSeq)) return;
      const headLog = renderEventLog(head, null);
      const summary = await agent.summarizeHistory(this.ctx(), this.state.memory?.summary ?? "", headLog);
      if (!summary) return; // 摘要失败保留旧记忆，下次事件再试
      await this.exclusive(async () => {
        if (!isNewerSeq(anchor.seq, this.state.memory?.anchorSeq)) return;
        this.state.memory = { anchorSeq: anchor.seq, summary };
        await persistState(this.gameId, this.state);
      });
    }, 100);
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
    // 重启后重 arm 未过期的真人超时定时器（auto 回调已丢失，只能走跳过降级）
    for (const [k, deadline] of Object.entries(this.state.humanDeadlines ?? {})) {
      const seat = Number(k);
      if (!Number.isFinite(seat)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) continue;
      this.schedule(`turn:${seat}`, async () => {
        this.clearHumanTimeout(seat);
        await persistState(this.gameId, this.state);
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

  /**
   * AI 发言（真流式）：句子级增量守卫随到随播，泄露句不会被放出；
   * 流式失败时回退到非流式（带重试 + fallback 链 + 全文守卫）。
   */
  private async aiSpeak(seatIndex: number, opts: { intro?: boolean; hint?: string } = {}): Promise<void> {
    publish(this.gameId, { kind: "thinking", seat: seatIndex, audience: "public" });
    let text = await this.consumeStream(
      () => agent.streamPlayerSpeech(this.ctx(), seatIndex, opts),
      (delta) => publish(this.gameId, { kind: "delta", seat: seatIndex, text: delta, audience: "public" }),
      AI_DECISION_TIMEOUT_MS
    );
    if (!text.trim()) {
      try {
        text = await withTimeout(agent.playerSpeak(this.ctx(), seatIndex, opts), AI_DECISION_TIMEOUT_MS);
      } catch (err) {
        await this.systemSay(`（AI 玩家「${this.speakerName(seatIndex)}」思考时遇到问题：${msgOf(err)}。场内玩家可稍作等待或继续。）`);
        publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
        return;
      }
    }
    if (!text.trim()) {
      await this.systemSay(`（AI 玩家「${this.speakerName(seatIndex)}」没有组织出有效发言，先跳过。）`);
      publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
      return;
    }
    text = await agent.refineSpeech(this.ctx(), seatIndex, text);
    await this.recordEvent({
      type: "speech",
      phase: this.state.phase,
      round: this.state.round,
      fromSeat: seatIndex,
      toSeat: null,
      visibility: "public",
      content: { text, speakerName: this.speakerName(seatIndex) },
    });
    publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
  }

  /** DM 旁白（真流式）：失败逐级回退 非流式 → 固定旁白。 */
  private async dmSay(task: string, phase: GameState["phase"] = this.state.phase, round = this.state.round): Promise<string> {
    publish(this.gameId, { kind: "thinking", seat: "dm", audience: "public" });
    let text = await this.consumeStream(
      () => agent.streamDmNarrate(this.ctx(), task),
      (delta) => publish(this.gameId, { kind: "delta", seat: "dm", text: delta, audience: "public" }),
      AI_DECISION_TIMEOUT_MS * 2
    );
    if (!text.trim()) {
      try {
        text = await withTimeout(agent.dmNarrate(this.ctx(), task), AI_DECISION_TIMEOUT_MS * 2);
      } catch {
        text = "";
      }
    }
    if (!text.trim()) text = `（主持人正在准备：${task}）`;
    await this.recordEvent({
      type: "phase",
      phase,
      round,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { text, phase, round },
    });
    publish(this.gameId, { kind: "thinking", seat: null, audience: "public" });
    return text;
  }

  /**
   * 消费一个流式生成器：delta 边收边推（观众可见），整体受超时约束。
   * 超时后置 stopped 丢弃剩余输出（连接由 chatStream 内部 abortSignal 兜底关闭），
   * 避免残句在回退发言期间混进事件流。
   */
  private async consumeStream(
    makeStream: () => AsyncGenerator<string>,
    onDelta: (delta: string) => void,
    timeoutMs: number
  ): Promise<string> {
    let text = "";
    let stopped = false;
    const consume = async (): Promise<void> => {
      for await (const delta of makeStream()) {
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

  private async systemSay(text: string, toSeat: number | null = null, extra?: Record<string, unknown>): Promise<void> {
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
    this.state.suggestions = {};
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
    this.resetActionPoints();
    await this.dmSay(
      `宣布进入【第 ${round} 轮搜证】：每位玩家选择一个地点进行搜证，找到的线索可以选择当场公开或私藏。轮次共 ${this.script.flow.searchRounds} 轮。`,
      "SEARCH",
      round
    );
    // 分幕读本：该轮对应的幕由 DM 宣布（同轮多幕逐一宣读），角色卡 stages 随之解锁
    for (const act of this.script.flow.acts.filter((a) => a.roundStart === round)) {
      const brief = act.brief?.length ? " " + act.brief.map((b) => ("text" in b ? b.text : "")).join(" ") : "";
      await this.dmSay(`【第${round}幕 · ${act.title}】${brief}`.trim(), "SEARCH", round);
    }
    await persistState(this.gameId, this.state);
    await this.tickInner();
  }

  private async transitionDiscussion(round: number): Promise<void> {
    this.state.phase = "DISCUSSION";
    this.state.round = round;
    this.state.spokenSeats = [];
    this.state.interjections = 0;
    this.state.pendingAnswer = null;
    this.state.suggestions = {};
    ensureDiscussionState(this.state);
    this.searchAsked.clear();
    this.turnAsked.clear();
    this.aiDiscussionAsked.clear();
    this.whisperAsked.clear();
    this.suggestAsked.clear();
    this.resetActionPoints();
    this.state.turnSeat = activeSeats(this.state)[0];
    await this.dmSay(
      `宣布进入【第 ${round} 轮圆桌讨论】：按座位顺序轮流发言，每人可当众提问三次。轮到你时请陈述或提问，被问到的人需要当场回答。发言时点名某位玩家，对方可能会立即插话回应；各位也可能收到其他玩家的悄悄私信，请留意界面提示。`,
      "DISCUSSION",
      round
    );
    await persistState(this.gameId, this.state);
    await this.tickInner();
  }

  /** 每轮行动点重置：仅当技能系统开启（actionPointsPerRound > 0）时按活跃座位发点 */
  private resetActionPoints(): void {
    this.state.actionPoints = {};
    if (this.script.flow.actionPointsPerRound > 0) {
      for (const seat of activeSeats(this.state)) {
        this.state.actionPoints[String(seat)] = this.script.flow.actionPointsPerRound;
      }
    }
  }

  private async transitionVote(): Promise<void> {
    this.state.phase = "VOTE";
    this.state.round = 1;
    this.state.votes = {};
    this.state.suggestions = {};
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
    const ended = await db.game.update({ where: { id: this.gameId }, data: { status: "ended", endedAt: new Date() } });
    await db.room.update({ where: { id: ended.roomId }, data: { status: "ended" } });
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
            await this.armHumanTimeout(seat, "自我介绍");
            await this.systemSay(`轮到你自我介绍了。请在输入框发言，或点击"跳过"。`, seat);
            this.queueSuggestReply(seat);
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
              await this.armHumanTimeout(seat, "选搜证地点", async () => {
                if (this.state.searchChoices[String(seat)]) return;
                const locs = this.fallbackLocations(seat);
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
        ensureDiscussionState(state);
        if (state.pendingAnswer) {
          await this.resolvePendingAnswer();
          return;
        }
        if (state.turnSeat === null) {
          const next = nextAfterDiscussion(state.round, this.script.flow.searchRounds, this.script.flow.discussionRounds);
          if (next === "SEARCH") await this.transitionSearch(state.round + 1);
          else if (next === "DISCUSSION") await this.transitionDiscussion(state.round + 1);
          else await this.transitionVote();
          return;
        }
        const seat = state.turnSeat;
        if (state.seats[seat]?.kind === "ai") {
          await this.runAiDiscussionTurn(seat);
        } else {
          const askKey = `ask:${state.phase}:${state.round}:${seat}`;
          if (!this.turnAsked.has(askKey)) {
            this.turnAsked.add(askKey);
            await this.armHumanTimeout(seat, "圆桌发言");
            const left = state.questionsLeft[String(seat)] ?? 0;
            await this.systemSay(`轮到你发言。你可以当众陈述，也可以提问（剩余 ${left} 次）。结束后请点「结束发言」。`, seat);
            this.queueSuggestReply(seat);
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
              await this.armHumanTimeout(seat, "投票", async () => {
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
      const locations = this.availableLocations(seat);
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

  /** 公开线索 id 集合（搜证权限/发放计划用） */
  private publicClueIds(): Set<string> {
    return new Set(Object.entries(this.state.clueStates).filter(([, st]) => st.isPublic).map(([id]) => id));
  }

  private seatCharacterId(seatIndex: number | null | undefined): string | null {
    if (seatIndex == null) return null;
    return this.state.seats[seatIndex]?.characterId || null;
  }

  /** 某座位角色卡上的技能卡 */
  private skillOf(seatIndex: number, skillId: string) {
    const charId = this.seatCharacterId(seatIndex);
    return this.script.characters.find((c) => c.id === charId)?.privateCard.skills.find((s) => s.id === skillId);
  }

  /** 某座位视角下可用的搜证地点（禁搜自己的房间/无可达线索的地点不列） */
  private availableLocations(seatIndex?: number): string[] {
    const seatChar = this.seatCharacterId(seatIndex);
    return this.script.locations
      .filter((loc) => {
        if (seatChar && loc.ownerCharacterId === seatChar) return false;
        return this.script.clues.some(
          (c) => c.locationId === loc.id && this.state.clueStates[c.id] === undefined && clueReachable(c, { seatCharacterId: seatChar, round: this.state.round, publicClueIds: this.publicClueIds() })
        );
      })
      .map((loc) => loc.name);
  }

  /** 兜底地点：无视发放计划/禁搜线索，但绝不给本人房间——只在正常列表为空时使用，保证流程不卡死。 */
  private fallbackLocations(seatIndex?: number): string[] {
    const seatChar = this.seatCharacterId(seatIndex);
    return this.script.locations
      .filter((loc) => !(seatChar && loc.ownerCharacterId === seatChar))
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

  private cluesAt(locationKey: string, seatIndex?: number) {
    const loc = resolveLocation(this.script, locationKey);
    if (!loc) return [];
    const seatChar = this.seatCharacterId(seatIndex);
    return this.script.clues.filter(
      (c) => c.locationId === loc.id && this.state.clueStates[c.id] === undefined && clueReachable(c, { seatCharacterId: seatChar, round: this.state.round, publicClueIds: this.publicClueIds() })
    );
  }

  private async dispatchClues(): Promise<void> {
    for (const seat of activeSeats(this.state)) {
      const loc = this.state.searchChoices[String(seat)];
      if (!loc) continue;
      const seatChar = this.seatCharacterId(seat);
      const chosen = resolveLocation(this.script, loc);
      if (seatChar && chosen?.ownerCharacterId === seatChar) {
        await this.systemSay(`（你不能搜自己的房间，本轮搜证落空。）`, seat);
        continue;
      }
      const candidates = this.cluesAt(loc, seat);
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
      await this.syncSeatClueIds(seat);
    }
  }

  /** 把某座位的持有线索写回 seatState（概要接口 myClues 的数据源） */
  private async syncSeatClueIds(seat: number): Promise<void> {
    await db.seatState
      .upsert({
        where: { gameId_seatIndex: { gameId: this.gameId, seatIndex: seat } },
        create: { gameId: this.gameId, seatIndex: seat, data: { clueIds: this.state.heldClues[seat] ?? [] } },
        update: { data: { clueIds: this.state.heldClues[seat] ?? [] } },
      })
      .catch(() => null);
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
              await this.systemSay(
                `（你已超过 3 分钟未操作，线索已全部自动私藏。）`,
                seat,
                { timeoutSkip: true }
              );
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

  private async submitQuestion(fromSeat: number, toSeat: number, question: string): Promise<{ ok: boolean; error?: string }> {
    const invalid = validateDiscussionAsk(this.state, fromSeat, toSeat);
    if (invalid) return { ok: false, error: invalid };
    const left = this.state.questionsLeft[String(fromSeat)] ?? 0;
    const text = question.trim().slice(0, 200);
    if (!text) return { ok: false, error: "问题不能为空" };
    this.state.questionsLeft[String(fromSeat)] = left - 1;
    this.state.pendingAnswer = { fromSeat, toSeat, question: text };
    // 提问 = 证明在参与，暂停提问者超时；答完后 tick 会重新 arm
    this.clearHumanTimeout(fromSeat);
    await this.recordEvent({
      type: "speech",
      phase: this.state.phase,
      round: this.state.round,
      fromSeat,
      toSeat,
      visibility: "public",
      content: { text: `我问${this.speakerName(toSeat)}：${text}`, speakerName: this.speakerName(fromSeat) },
    });
    await persistState(this.gameId, this.state);
    return { ok: true };
  }

  private async resolvePendingAnswer(): Promise<void> {
    const pending = this.state.pendingAnswer;
    if (!pending) return;
    const target = pending.toSeat;
    if (this.state.seats[target]?.kind === "ai") {
      const base = `${this.speakerName(pending.fromSeat)} 当众问你：「${pending.question}」。`;
      await this.aiSpeak(target, {
        hint: pending.forced
          ? forcedAnswerHint(base)
          : `${base}请正面回答这个问题；可以藏秘密，但不能装作没听见。`,
      });
      this.state.pendingAnswer = null;
      await persistState(this.gameId, this.state);
      await this.tickInner();
      return;
    }
    const askKey = `answer:${pending.fromSeat}:${target}:${this.state.round}`;
    if (!this.turnAsked.has(askKey)) {
      this.turnAsked.add(askKey);
      await this.armHumanTimeout(target, "回答提问", async () => {
        if (!this.state.pendingAnswer) return;
        await this.systemSay(`（${this.speakerName(target)} 没有回答，「${pending.question}」作废。）`);
        this.state.pendingAnswer = null;
        await persistState(this.gameId, this.state);
        await this.tickInner();
      });
      await this.systemSay(`请当场回答「${this.speakerName(pending.fromSeat)}」的提问：${pending.question}`, target);
    }
  }

  private async runAiDiscussionTurn(seat: number): Promise<void> {
    if (!this.aiDiscussionAsked.has(seat)) {
      this.aiDiscussionAsked.add(seat);
      const left = this.state.questionsLeft[String(seat)] ?? 0;
      if (left > 0) {
        try {
          const asked = await withTimeout(
            agent.playerConsiderQuestion(this.ctx(), seat, activeSeats(this.state).filter((i) => i !== seat)),
            AI_DECISION_TIMEOUT_MS,
          );
          if (asked) {
            const result = await this.submitQuestion(seat, asked.toSeat, asked.question);
            if (result.ok) {
              this.pendingTick = true;
              return;
            }
          }
        } catch {
          /* 不问，直接发言 */
        }
      }
    }
    await this.aiSpeak(seat, {
      hint: `现在轮到你当众发言。根据公开信息和你愿意拿出的情报做一段陈述，不要连珠炮质问，也不要替别人作答。`,
    });
    this.markSpoken(seat);
    await this.nextTurnOrAdvance();
    this.maybeQueueWhisper(seat);
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

  private async armHumanTimeout(seat: number, label: string, auto?: () => Promise<void>): Promise<void> {
    if (this.unlimitedHumanTurns) return;
    this.state.humanDeadlines ??= {};
    this.state.humanDeadlines[String(seat)] = Date.now() + HUMAN_TURN_TIMEOUT_MS;
    // 先落库再提示：紧跟其后的「轮到你」事件会触发前端刷新概要，必须能读到截止时间
    await persistState(this.gameId, this.state);
    this.schedule(`turn:${seat}`, async () => {
      this.clearHumanTimeout(seat);
      await persistState(this.gameId, this.state);
      await this.systemSay(
        `（你已超过 3 分钟未操作，${auto ? `${label}已由系统自动处理。` : "本轮发言已自动跳过。"}）`,
        seat,
        { timeoutSkip: true }
      );
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

  /** 真人行动到达时解除限时：清定时器 + 清截止时间（调用点随后都会 persistState）。 */
  private clearHumanTimeout(seat: number): void {
    this.clearTimers(`turn:${seat}`);
    if (this.state.humanDeadlines) delete this.state.humanDeadlines[String(seat)];
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
          this.clearSuggestions(seatIndex);
          this.clearHumanTimeout(seatIndex);
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
              content: { text, speakerName: this.speakerName(seatIndex) },
            });
            this.clearHumanTimeout(seatIndex);
            this.state.pendingAnswer = null;
            await persistState(this.gameId, this.state);
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
          this.clearSuggestions(seatIndex);
          await persistState(this.gameId, this.state);
          // 点名了某位 AI → 对方可以立即简短插话回应（不占回合）
          this.maybeQueueInterjection(seatIndex, text);
          return { ok: true };
        }
        return { ok: false, error: "当前不能自由发言" };
      }
      case "ask": {
        return this.submitQuestion(seatIndex, action.toSeat ?? -1, action.text ?? "");
      }
      case "skip": {
        if (this.state.phase !== "SELF_INTRO" && this.state.phase !== "DISCUSSION") {
          return { ok: false, error: "当前没有可跳过的发言回合" };
        }
        if (this.state.phase === "DISCUSSION" && this.state.pendingAnswer) {
          if (this.state.pendingAnswer.toSeat === seatIndex) {
            this.clearHumanTimeout(seatIndex);
            await this.systemSay("（你拒绝回答这个问题。）");
            this.state.pendingAnswer = null;
            await persistState(this.gameId, this.state);
            this.continueTick();
            return { ok: true };
          }
          return { ok: false, error: "请先等待对方回答" };
        }
        if (this.state.turnSeat !== seatIndex) return { ok: false, error: "现在还没轮到你发言" };
        this.clearHumanTimeout(seatIndex);
        this.clearSuggestions(seatIndex);
        this.markSpoken(seatIndex);
        await this.systemSay("（你结束了本轮发言。）", seatIndex);
        await this.nextTurnOrAdvance();
        return { ok: true };
      }
      case "choose_location": {
        if (this.state.phase !== "SEARCH") return { ok: false, error: "当前不在搜证环节" };
        if (this.state.searchChoices[String(seatIndex)]) return { ok: false, error: "本轮已经选过地点" };
        const loc = resolveLocation(this.script, action.location ?? "");
        if (!loc) return { ok: false, error: "地点不合法" };
        if (loc.ownerCharacterId === this.seatCharacterId(seatIndex)) {
          return { ok: false, error: "你不能搜自己的房间" };
        }
        if (this.availableLocations(seatIndex).length > 0 && this.cluesAt(loc.name, seatIndex).length === 0) {
          return { ok: false, error: `「${loc.name}」的线索已搜完，请选择其他地点` };
        }
        this.state.searchChoices[String(seatIndex)] = loc.name;
        this.clearHumanTimeout(seatIndex);
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
        this.clearHumanTimeout(seatIndex);
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
        const skill = this.skillOf(seatIndex, skillId);
        if (!skill || toSeat === undefined) return { ok: false, error: "技能不可用" };
        this.state.actionPoints ??= {};
        this.state.actionPoints[String(seatIndex)] = (this.state.actionPoints[String(seatIndex)] ?? 0) - skill.cost;
        this.state.usedSkills ??= [];
        if (skill.once) this.state.usedSkills.push(`${seatIndex}:${skill.id}`);
        this.state.pendingAnswer = { fromSeat: seatIndex, toSeat, question: text, forced: true };
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
          },
        });
        await persistState(this.gameId, this.state);
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
        await this.syncSeatClueIds(seatIndex);
        await this.syncSeatClueIds(toSeat);
        await persistState(this.gameId, this.state);
        return { ok: true };
      }
      case "private_chat": {
        // ★ AI 主动私信的回复通道 ★：只有当某位 AI 向你开过私信窗口时才能回复。
        if (this.state.phase !== "DISCUSSION") return { ok: false, error: "当前不在讨论环节" };
        const toSeat = action.toSeat ?? -1;
        const target = this.state.seats[toSeat];
        if (!target || target.kind !== "ai") return { ok: false, error: "只能回复 AI 玩家的私信" };
        const key = `${toSeat}-${seatIndex}`;
        if ((this.state.privateChat[key] ?? 0) <= 0) return { ok: false, error: "对方没有向你发起私信" };
        const text = (action.text ?? "").trim().slice(0, 300);
        if (!text) return { ok: false, error: "回复不能为空" };
        this.state.privateChat[key] = 0;
        await this.recordEvent({
          type: "private",
          phase: this.state.phase,
          round: this.state.round,
          fromSeat: seatIndex,
          toSeat,
          visibility: `seat:${toSeat}`,
          content: { text },
        });
        await persistState(this.gameId, this.state);
        this.queueAiPrivateReply(toSeat, seatIndex, text);
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

/** 事件序号（BigInt 字符串）比较：a 是否比 b 新 */
function isNewerSeq(a: string | undefined, b: string | undefined): boolean {
  return BigInt(a ?? "0") > BigInt(b ?? "0");
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
