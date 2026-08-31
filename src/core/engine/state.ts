import { db } from "@/lib/db";
import { publish } from "./bus";
import type { EngineEvent, GameState, Phase, SeatInfo } from "./types";
import type { Prisma } from "@prisma/client";
import type { GameEvent } from "@prisma/client";

/** 初始状态 */
export function initialState(seats: SeatInfo[]): GameState {
  return {
    phase: "LOBBY",
    round: 0,
    seats,
    clueStates: {},
    heldClues: {},
    readySeats: [],
    spokenSeats: [],
    turnSeat: null,
    votes: {},
    privateChat: {},
    searchChoices: {},
    pendingPublish: {},
    searchDealtRound: 0,
    voteResult: null,
    interjections: 0,
  };
}

/** 从 DB 事件流重建状态（服务重启/恢复用）。事件中带 phase/round 快照 + 关键动作。 */
export function rebuildStateFromEvents(base: GameState, events: GameEvent[]): GameState {
  const state: GameState = { ...base, clueStates: { ...base.clueStates }, heldClues: { ...base.heldClues } };
  for (const ev of events) {
    const phase = ev.phase as Phase;
    state.phase = phase;
    state.round = ev.round;
    switch (ev.type) {
      case "clue": {
        const clueId = (ev.content as { clueId?: string }).clueId;
        const seat = ev.fromSeat ?? -1;
        const isPublic = ev.visibility === "public";
        if (clueId) {
          if (state.clueStates[clueId] === undefined) {
            state.clueStates[clueId] = { discoveredBy: seat, isPublic: false };
          }
          if (isPublic) state.clueStates[clueId].isPublic = true;
          if (!isPublic && seat >= 0) {
            state.heldClues[seat] = [...(state.heldClues[seat] ?? []), clueId];
          }
        }
        break;
      }
      case "vote": {
        if (ev.fromSeat !== null) {
          const content = ev.content as { target?: number; reason?: string };
          if (content.target !== undefined) {
            state.votes[String(ev.fromSeat)] = { target: content.target, reason: content.reason };
          }
        }
        break;
      }
      case "phase":
        state.spokenSeats = [];
        state.searchChoices = {};
        state.interjections = 0;
        break;
      default:
        break;
    }
  }
  return state;
}

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
      content: ev.content as Prisma.InputJsonValue,
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

/** 事件可见性过滤：玩家视角只看 public + 自己座位 */
export function visibleTo(event: EngineEvent, seatIndex: number | null): boolean {
  if (event.visibility === "public") return true;
  if (seatIndex === null) return false; // null = 纯观战：仅 public
  if (event.visibility === `seat:${seatIndex}`) return true;
  if (event.type === "speech" && event.fromSeat === seatIndex) return true;
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

/** 座位人数与存活座位（MVP 全员存活） */
export function activeSeats(state: GameState): number[] {
  return state.seats.filter((s) => s.kind !== "empty").map((s) => s.index);
}

export function nextSeat(state: GameState, from: number): number | null {
  const seats = activeSeats(state);
  const idx = seats.indexOf(from);
  if (idx < 0 || seats.length === 0) return seats[0] ?? null;
  return seats[(idx + 1) % seats.length];
}
