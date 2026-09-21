import { describe, it, expect } from "vitest";
import { defenseBroken } from "./defense";
import { validatePlayerActionPlan } from "./plan";
import { initialState } from "@/core/engine/state";
import { parseScriptForRuntime } from "@/core/script/compat";
import { readFileSync } from "node:fs";
const script = parseScriptForRuntime(JSON.parse(readFileSync("seeds/generated/5p-diqifengheka.json", "utf8")));
const state = initialState(script.characters.map((c, index) => ({ index, characterId: c.id, kind: "ai", playerName: c.name })));
const base = { id: "h", claim: "辩解", basis: "依据" };
describe("辩解生命周期", () => {
  it("all 需全部公开，any 和旧字段任一公开即失效", () => {
    const s = { clueStates: { a: { discoveredBy: 0, isPublic: true } } };
    expect(defenseBroken({ ...base, brokenWhen: { allPublicClueIds: ["a", "b"] } }, s)).toBe(false);
    expect(defenseBroken({ ...base, brokenWhen: { allPublicClueIds: ["a"] } }, s)).toBe(true);
    expect(defenseBroken({ ...base, brokenWhen: { anyPublicClueIds: ["a", "b"] } }, s)).toBe(true);
    expect(defenseBroken({ ...base, brokenByPublicClueIds: ["a", "b"] }, s)).toBe(true);
  });
  it("贺卡第一轮至少保有一条辩解，终局全部击破", () => {
    const hooks = script.characters.find((c) => c.id === "zhao_kai")!.privateCard.defenseHooks;
    for (const clue of script.clues.filter((c) => (c.release?.round ?? 1) <= 1)) state.clueStates[clue.id] = { discoveredBy: 0, isPublic: true };
    expect(hooks.some((h) => !defenseBroken(h, state))).toBe(true);
    const first = validatePlayerActionPlan({ script, state, events: [], gameId: "test" }, 1, { defenseHookId: "invalid", focusEvidenceIds: ["shouji_sousuo", "yaohe_xiaopiao"], claimSummary: "甲".repeat(100) })!;
    expect(first.defenseHookId).toBe("defense_unaware");
    expect(first.claimSummary).toHaveLength(80);
    expect(first.focusEvidenceIds).toEqual(["yaohe_xiaopiao"]);
    for (const clue of script.clues) state.clueStates[clue.id] = { discoveredBy: 0, isPublic: true };
    expect(hooks.every((h) => defenseBroken(h, state))).toBe(true);
  });
});
