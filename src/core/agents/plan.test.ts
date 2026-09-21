import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptForRuntime } from "@/core/script/compat";
import { initialState } from "@/core/engine/state";
import { validatePlayerActionPlan } from "./plan";

const script = parseScriptForRuntime(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf8")));
const state = initialState(script.characters.slice(0, 5).map((character, index) => ({ index, kind: "ai" as const, characterId: character.id, playerName: character.name })));
state.clueStates[script.clues[0].id] = { discoveredBy: 0, isPublic: true };

describe("角色行动计划", () => {
  it("只保留合法目标、可见线索和活跃目标座位", () => {
    const ctx = { script, state, events: [], gameId: "test" };
    const plan = validatePlayerActionPlan(ctx, 0, {
      objectiveId: script.characters[0].privateCard.objectives[0].id,
      targetSeat: 1,
      discloseClueIds: [script.clues[0].id, "hidden"],
      holdClueIds: [script.clues[0].id],
      nextAction: "probe",
    });
    expect(plan).toEqual({
      focusEvidenceIds: [], claimSummary: null, defenseHookId: null,
      objectiveId: script.characters[0].privateCard.objectives[0].id,
      targetSeat: 1,
      discloseClueIds: [script.clues[0].id],
      holdClueIds: [script.clues[0].id],
      nextAction: "probe",
    });
  });

  it("非法格式回退为安全的观察计划", () => {
    const ctx = { script, state, events: [], gameId: "test" };
    expect(validatePlayerActionPlan(ctx, 0, { objectiveId: "truth", targetSeat: 99, nextAction: "mutate" })).toEqual({
      focusEvidenceIds: [], claimSummary: null, defenseHookId: null,
      objectiveId: null,
      targetSeat: null,
      discloseClueIds: [],
      holdClueIds: [],
      nextAction: "state",
    });
  });
});
