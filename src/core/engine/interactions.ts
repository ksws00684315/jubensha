import { agent } from "@/core/agents";
import type { GameEngine } from "./engine";
import { AI_DECISION_TIMEOUT_MS, HUMAN_TURN_TIMEOUT_MS, withTimeout } from "./util";

export async function chooseInteraction(e: GameEngine, seat: number, beatId: string, choiceId: string, source = "player"): Promise<{ ok: boolean; error?: string }> {
  const beat = e.script.flow.interactionBeats?.find((item) => item.id === beatId);
  const pending = e.state.pendingInteraction;
  if (!beat || !pending || pending.beatId !== beatId || pending.seatIndex !== seat || e.state.phase !== "DISCUSSION") return { ok: false, error: "当前没有等待你的互动选择" };
  const choice = beat.choices.find((item) => item.id === choiceId);
  if (!choice) return { ok: false, error: "互动选项不存在" };
  e.state.interactionChoices ??= {};
  if (!e.state.interactionChoices[beatId]) {
    await e.recordEvent({ type: "interaction", phase: e.state.phase, round: e.state.round, fromSeat: seat, toSeat: null,
      visibility: beat.visibility === "public" ? "public" : `seat:${seat}`,
      content: { beatId, choiceId, source, text: `${e.speakerName(seat)}：${choice.recap}`, recap: choice.recap, speakerName: e.speakerName(seat) } });
    e.state.interactionChoices[beatId] = { seatIndex: seat, choiceId, round: e.state.round };
  }
  e.state.pendingInteraction = null;
  e.clearTimers(`interaction:${beatId}`);
  await e.persist();
  e.continueTick();
  return { ok: true };
}

/** 在讨论结束与下一阶段之间串行执行；返回 true 表示仍在等待选择。 */
export async function runInteractionBeats(e: GameEngine): Promise<boolean> {
  e.state.interactionChoices ??= {};
  const beat = e.script.flow.interactionBeats?.find((item) => item.round === e.state.round && !e.state.interactionChoices?.[item.id]);
  if (!beat) return false;
  const seat = e.state.seats.find((item) => item.characterId === beat.characterId && item.kind !== "empty");
  if (!seat) {
    await e.recordEvent({ type: "interaction", phase: e.state.phase, round: e.state.round, fromSeat: null, toSeat: null, visibility: "dm", content: { beatId: beat.id, skipped: true, text: "角色未入座，跳过互动" } });
    e.state.interactionChoices[beat.id] = { seatIndex: -1, choiceId: beat.defaultChoiceId, round: e.state.round, skipped: true };
    await e.persist();
    return runInteractionBeats(e);
  }
  if (!e.state.pendingInteraction) {
    e.state.pendingInteraction = { beatId: beat.id, seatIndex: seat.index, deadlineAt: Date.now() + HUMAN_TURN_TIMEOUT_MS };
    await e.persist();
    await e.systemSay(beat.prompt, beat.visibility === "public" ? null : seat.index);
  }
  const key = `interaction:${beat.id}`;
  if (!e.timers.has(key)) {
    const remaining = Math.max(0, (e.state.pendingInteraction.deadlineAt ?? Date.now() + HUMAN_TURN_TIMEOUT_MS) - Date.now());
    e.schedule(key, async () => { await chooseInteraction(e, seat.index, beat.id, beat.defaultChoiceId, "timeout_default"); }, remaining);
  }
  if (seat.kind === "ai" && !e.turnAsked.has(key)) {
    e.turnAsked.add(key);
    e.scheduleBackground(`${key}:ai`, async () => {
      let choiceId = beat.defaultChoiceId;
      let source = "ai";
      try { choiceId = await withTimeout(agent.playerInteraction(e.ctx(), seat.index, beat), AI_DECISION_TIMEOUT_MS); }
      catch { source = "generation_default"; }
      await e.exclusive(async () => { await chooseInteraction(e, seat.index, beat.id, choiceId, source); });
    }, 50);
  }
  return true;
}

export function interactionRecaps(e: GameEngine) {
  return (e.script.flow.interactionBeats ?? []).flatMap((beat) => {
    const result = e.state.interactionChoices?.[beat.id];
    if (!result || result.skipped || beat.visibility !== "public") return [];
    const choice = beat.choices.find((item) => item.id === result.choiceId);
    return choice ? [{ beatId: beat.id, seatIndex: result.seatIndex, choiceId: choice.id, text: `${e.speakerName(result.seatIndex)}：${choice.recap}` }] : [];
  });
}
