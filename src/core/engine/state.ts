import { db } from "@/lib/db";
import { publish } from "./bus";
import type { EngineEvent, GameState, Phase, SeatInfo } from "./types";
import type { Prisma } from "@prisma/client";

/** 初始状态 */
export function initialState(seats: SeatInfo[]): GameState {
  return {
    phase: "LOBBY",
    round: 0,
    seats,
    clueStates: {},
    heldClues: {},
    readySeats: [],
    readingPromptedSeats: [],
    spokenSeats: [],
    turnSeat: null,
    votes: {},
    privateChat: {},
    searchChoices: {},
    pendingPublish: {},
    searchDealtRound: 0,
    voteResult: null,
    interjections: 0,
    questionsLeft: {},
    pendingAnswer: null,
    unlockedSecrets: {},
    hostHandouts: {},
    hostHints: {},
    actionPlans: {},
    pendingInteraction: null,
    interactionChoices: {},
  };
}

/** 事件写入/输出的安全投影：LLM 路由用途属于服务端元数据，不能进入玩家事件流。 */
export function sanitizeEventContent(content: Record<string, unknown>): Record<string, unknown> {
  const { purpose: _purpose, ...safe } = content;
  void _purpose;
  return safe;
}

/**
 * 状态恢复路径说明：权威来源是 `games.state` 快照（`GameEngine.load()` 直接读取并补默认值）。
 * 事件流 `game_events` 是 append-only 的，用于 SSE 断线续传与事后审计，**不用于重建状态**——
 * 早期这里有一个 `rebuildStateFromEvents`，但它既不覆盖技能/答题/限时/提问等新状态、也没有任何调用者，
 * 只会让人误以为"重启靠重放事件恢复"。重放协议若要补齐，须与"锁外生成"重构同期做。
 */

/** 追加事件：落库 + 总线广播。返回完整事件。 */
export async function appendEvent(
  gameId: string,
  ev: Omit<EngineEvent, "seq" | "createdAt"> & { content: Record<string, unknown> }
): Promise<EngineEvent> {
  const row = await db.gameEvent.create({
    data: {
      gameId,
      type: ev.type,
      phase: ev.phase,
      round: ev.round,
      fromSeat: ev.fromSeat,
      toSeat: ev.toSeat,
      visibility: ev.visibility,
      content: sanitizeEventContent(ev.content) as Prisma.InputJsonValue,
    },
  });
  const event: EngineEvent = {
    seq: row.seq.toString(),
    type: row.type as EngineEvent["type"],
    phase: row.phase as Phase,
    round: row.round,
    fromSeat: row.fromSeat,
    toSeat: row.toSeat,
    visibility: row.visibility,
    content: row.content as EngineEvent["content"],
    createdAt: row.createdAt.toISOString(),
  };
  publish(gameId, { kind: "event", event });
  return event;
}

/** 持久化引擎状态快照 */
export async function persistState(gameId: string, state: GameState): Promise<void> {
  await db.game.update({ where: { id: gameId }, data: { phase: state.phase, round: state.round, state: state as unknown as Prisma.InputJsonValue } });
}

/** 事件可见性过滤：玩家视角只看 public + 自己座位 + 自己发出的私聊/转交 */
export function visibleTo(event: EngineEvent, seatIndex: number | null): boolean {
  if (event.visibility === "public") return true;
  if (seatIndex === null) return false; // null = 纯观战：仅 public
  if (event.visibility === `seat:${seatIndex}`) return true;
  if (event.type === "speech" && event.fromSeat === seatIndex) return true;
  if ((event.type === "private" || event.type === "transfer") && event.fromSeat === seatIndex) return true;
  return false;
}

/**
 * 把事件流渲染成给 LLM 看的文本（防火墙的出口：按视角过滤后再渲染）。
 */
export function renderEventLog(events: EngineEvent[], seatIndex: number | null, opts: { includePrivate?: boolean } = {}): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (!visibleTo(ev, seatIndex)) continue;
    if (ev.type === "private" && !opts.includePrivate) continue;
    const phase = ev.phase;
    switch (ev.type) {
      case "phase":
        lines.push(`【系统】进入阶段：${ev.content.phase ?? phase}${ev.round ? `（第 ${ev.round} 轮）` : ""}`);
        if (typeof ev.content.text === "string" && ev.content.text) lines.push(`【主持人】${ev.content.text}`);
        break;
      case "speech": {
        const who = ev.fromSeat === null ? "主持人" : `${ev.content.speakerName ?? `玩家${ev.fromSeat + 1}`}`;
        lines.push(`【${who}】${ev.content.text ?? ""}`);
        break;
      }
      case "interaction":
      case "system":
        lines.push(`【系统】${ev.content.text ?? ""}`);
        break;
      case "clue": {
        const name = ev.content.clueName ?? ev.content.clueId;
        if (ev.visibility === "public") {
          lines.push(`【线索·公开】${name}: ${ev.content.clueContent ?? ""}`);
        } else {
          lines.push(`【线索·仅你可见】${name}: ${ev.content.clueContent ?? ""}`);
        }
        break;
      }
      case "vote":
        if (ev.visibility === "public") lines.push(`【系统】${ev.content.text ?? ""}`);
        break;
      case "private": {
        const from = ev.fromSeat === seatIndex ? "你" : `玩家${(ev.fromSeat ?? 0) + 1}`;
        const to = ev.toSeat === seatIndex ? "你" : `玩家${(ev.toSeat ?? 0) + 1}`;
        lines.push(`【私聊 ${from} → ${to}】${ev.content.text ?? ""}`);
        break;
      }
      case "transfer": {
        const dir = ev.fromSeat === seatIndex ? "你交出" : "你收到";
        lines.push(`【线索转交】${dir}「${ev.content.clueName ?? ev.content.clueId ?? "?"}」: ${ev.content.clueContent ?? ""}`);
        break;
      }
      case "thinking":
        break;
      case "reveal":
        lines.push(`【复盘】${ev.content.text ?? ""}`);
        break;
    }
  }
  return lines.join("\n");
}

/** 玩家可见线索：自己持有的 + 已公开的。未发现的不出现在概要里。 */
export function cluesVisibleToSeat(
  clues: Array<{ id: string; name: string; location: string }>,
  state: Pick<GameState, "clueStates" | "heldClues">,
  seatIndex: number
): Array<{ id: string; name: string; location: string }> {
  const held = new Set((state.heldClues ?? {})[seatIndex] ?? []);
  const clueStates = state.clueStates ?? {};
  return clues.filter((c) => clueStates[c.id]?.isPublic || held.has(c.id)).map((c) => ({
    id: c.id,
    name: c.name,
    location: c.location,
  }));
}

/**
 * 线索对某座位是否可达（搜证权限）：
 *  - forbiddenCharacterIds 含该角色 → 永不可搜；
 *  - release.round 未到 / afterCluePublicIds 有未公开前置 → 本轮不可搜。
 */
export function clueReachable(
  clue: { forbiddenCharacterIds?: string[]; release?: { round?: number; afterCluePublicIds?: string[] } },
  opts: { seatCharacterId?: string | null; round: number; publicClueIds: Iterable<string> }
): boolean {
  if (opts.seatCharacterId && clue.forbiddenCharacterIds?.includes(opts.seatCharacterId)) return false;
  if (clue.release?.round !== undefined && clue.release.round > opts.round) return false;
  const pub = new Set(opts.publicClueIds);
  for (const id of clue.release?.afterCluePublicIds ?? []) {
    if (!pub.has(id)) return false;
  }
  return true;
}

/** 座位人数与存活座位（MVP 全员存活） */
export function activeSeats(state: Pick<GameState, "seats">): number[] {
  return state.seats.filter((s) => s.kind !== "empty").map((s) => s.index);
}

export function nextSeat(state: GameState, from: number): number | null {
  const seats = activeSeats(state);
  const idx = seats.indexOf(from);
  if (idx < 0 || seats.length === 0) return seats[0] ?? null;
  return seats[(idx + 1) % seats.length];
}
