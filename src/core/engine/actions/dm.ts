import { db } from "@/lib/db";
import { activeSeats } from "../state";
import { clearHumanTimeout } from "../human-turn";
import { clueText } from "@/core/script/compat";
import type { GameEngine } from "../engine";

export interface DmAction { type: "narrate" | "nudge" | "skip_turn" | "handout" | "hint" | "force_ready" | "abort_game"; text?: string; clueId?: string; hintIndex?: number; seatIndex?: number }
type Result = { ok: boolean; error?: string };
type Handler = (e: GameEngine, action: DmAction) => Promise<Result>;

export const DM_ACTIONS: Record<DmAction["type"], Handler> = {
  "force_ready": async (e, action) => {
    if (e.state.phase !== "READING") return { ok: false, error: "当前不在读本环节" };
    const seat = action.seatIndex;
    if (seat === undefined || !activeSeats(e.state).includes(seat)) return { ok: false, error: "座位不存在" };
    if (!e.state.readySeats.includes(seat)) e.state.readySeats.push(seat);
    clearHumanTimeout(e, seat);
    await e.systemSay(`（真人 DM 已代座位${seat + 1}完成读本确认。）`, seat);
    await e.persist();
    e.continueTick();
    return { ok: true };
  },
  "abort_game": async (e) => {
    e.clearTimers();
    e.activeAbortController?.abort();
    e.state.phase = "ENDED";
    e.state.pendingAnswer = null;
    await e.systemSay(`（真人 DM 已中止本局，对局状态已封存。）`);
    await e.persist();
    await db.$transaction(async (tx) => {
      const ended = await tx.game.update({ where: { id: e.gameId }, data: { status: "aborted", endedAt: new Date() } });
      await tx.room.update({ where: { id: ended.roomId }, data: { status: "aborted" } });
    });
    return { ok: true };
  },
  "narrate": async (e, action) => {
    const text = (action.text ?? "").trim().slice(0, 500);
    if (!text) return { ok: false, error: "内容不能为空" };
    await e.recordEvent({
      type: "system",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { text: `【真人DM】${text}` },
    });
    return { ok: true };
  },
  "nudge": async (e) => {
    e.continueTick();
    return { ok: true };
  },
  "skip_turn": async (e) => {
    if ((e.state.phase === "SELF_INTRO" || e.state.phase === "DISCUSSION") && e.state.turnSeat !== null) {
      const seat = e.state.turnSeat;
      e.markSpoken(seat);
      await e.systemSay(`（真人DM 跳过了本回合的发言。）`);
      await e.nextTurnOrAdvance();
    } else {
      e.continueTick();
    }
    return { ok: true };
  },
  "handout": async (e, action) => {
    const clueId = action.clueId?.trim();
    const clue = clueId ? e.script.clues.find((candidate) => candidate.id === clueId) : undefined;
    if (!clue) return { ok: false, error: "线索不存在" };
    if (clue.policy === "keep_private") return { ok: false, error: "该线索被作者标记为不可公开" };
    if (e.state.clueStates[clue.id]?.isPublic) return { ok: true };
    e.state.clueStates[clue.id] = { discoveredBy: e.state.clueStates[clue.id]?.discoveredBy ?? null, isPublic: true };
    e.state.hostHandouts ??= {};
    e.state.hostHandouts[clue.id] = { round: e.state.round, reason: "manual_dm" };
    await e.recordEvent({
      type: "clue",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), hostRelease: true, manual: true },
    });
    await e.systemSay(`真人 DM 公开补发线索卡【${clue.name}】。`);
    await e.persist();
    return { ok: true };
  },
  "hint": async (e, action) => {
    const index = action.hintIndex;
    const hint = index === undefined ? undefined : e.script.hostGuide?.stallBreakers[index];
    if (!hint) return { ok: false, error: "主持提示不存在" };
    e.state.hostHints ??= {};
    const key = `${e.state.round}:${index}`;
    if (e.state.hostHints[key]) return { ok: true };
    e.state.hostHints[key] = { round: e.state.round, condition: hint.condition, hint: hint.hint };
    await e.systemSay(`【主持提示】${hint.hint}`);
    await e.persist();
    return { ok: true };
  },
};

export async function handleUnknownDmAction(): Promise<Result> {
  return { ok: false, error: "未知 DM 动作" };
}
