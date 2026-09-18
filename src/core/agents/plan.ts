import type { AgentCtx } from "./index";
import { characterOf } from "./context";
import type { PlayerActionPlan } from "@/core/engine/types";

export function renderActionPlan(plan: PlayerActionPlan): string {
  const target = plan.targetSeat == null ? "暂不指定对象" : `座位${plan.targetSeat + 1}`;
  const disclose = plan.discloseClueIds.length ? plan.discloseClueIds.join("、") : "暂不公开线索";
  const hold = plan.holdClueIds.length ? plan.holdClueIds.join("、") : "无特别保留";
  return `【本回合行动计划（仅供你组织说法，不得逐字念出）】目标：${plan.objectiveId ?? "先观察局面"}；回应对象：${target}；准备公开：${disclose}；准备保留：${hold}；下一步：${plan.nextAction}`;
}

/** 只接受合法候选，不让模型直接修改游戏状态。 */
export function validatePlayerActionPlan(ctx: AgentCtx, seatIndex: number, value: unknown): PlayerActionPlan | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const character = characterOf(ctx.script, ctx.state, seatIndex);
  if (!character) return null;
  const objectiveIds = new Set(character.privateCard.objectives.map((item) => item.id));
  const visibleClues = new Set([
    ...(ctx.state.heldClues[seatIndex] ?? []),
    ...ctx.script.clues.filter((clue) => ctx.state.clueStates[clue.id]?.isPublic).map((clue) => clue.id),
  ]);
  const targetSeat = typeof raw.targetSeat === "number" && Number.isInteger(raw.targetSeat) && ctx.state.seats.some((seat) => seat.index === raw.targetSeat && seat.kind !== "empty" && seat.index !== seatIndex) ? raw.targetSeat : null;
  const list = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string" && visibleClues.has(item)).slice(0, 8) : [];
  const nextAction = ["state", "ask", "defend", "probe", "exchange", "wait"].includes(String(raw.nextAction)) ? String(raw.nextAction) as PlayerActionPlan["nextAction"] : "state";
  return {
    objectiveId: typeof raw.objectiveId === "string" && objectiveIds.has(raw.objectiveId) ? raw.objectiveId : null,
    targetSeat,
    discloseClueIds: list(raw.discloseClueIds),
    holdClueIds: list(raw.holdClueIds),
    nextAction,
  };
}
