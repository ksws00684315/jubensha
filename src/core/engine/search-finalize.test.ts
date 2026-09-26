import { describe, it, expect, vi } from "vitest";
import { initialState } from "./state";
import { finalizeSearchRound } from "./search-deal";
import type { GameEngine } from "./engine";
vi.mock("./phases", () => ({ afterSearchPhase: vi.fn(async (e) => { e.state.phase = "DISCUSSION"; }) }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/core/agents", () => ({ agent: {} }));
function fixture(count = 1) {
  const state = initialState([]);
  Object.assign(state, { phase: "SEARCH", round: 1, searchDealtRound: 1, pendingPublish: { "0": ["c0"] } });
  const events: unknown[] = [];
  const e = { state, events, script: {
    clues: Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `线索${i}`, policy: "manual_public", content: [{ type: "paragraph", text: "材料" }] })),
    hostGuide: { guaranteedPublicClues: Array.from({ length: count }, (_, i) => ({ clueId: `c${i}`, deadlineRound: 1 })) },
  }, persist: vi.fn(async () => {}), recordEvent: vi.fn(async (event) => { events.push(event); }), systemSay: vi.fn(), schedule: vi.fn() };
  return e as unknown as GameEngine;
}
describe("搜证截止结算", () => {
  it.each([true, false])("等待玩家选择后结算，公开=%s，重复请求只发一次", async (published) => {
    const e = fixture();
    await finalizeSearchRound(e);
    expect(e.events).toHaveLength(0);
    expect(e.state.phase).toBe("SEARCH");
    e.state.pendingPublish["0"] = [];
    e.state.clueStates.c0 = { discoveredBy: 0, isPublic: published };
    await finalizeSearchRound(e);
    await finalizeSearchRound(e);
    expect(e.events).toHaveLength(published ? 0 : 1);
    expect(e.state.phase).toBe("DISCUSSION");
  });
  it("一轮最多补发两张，其余推迟到后面的搜证轮", async () => {
    const e = fixture(6);
    e.state.pendingPublish = {};
    await finalizeSearchRound(e);
    expect(e.events).toHaveLength(2);
    expect(e.state.phase).toBe("DISCUSSION");
    expect(e.schedule).not.toHaveBeenCalled();
    e.state = JSON.parse(JSON.stringify(e.state));
    e.state.phase = "SEARCH";
    e.state.round = 2;
    e.state.searchDealtRound = 2;
    await finalizeSearchRound(e);
    expect(e.events).toHaveLength(4);
    e.state.phase = "SEARCH";
    e.state.round = 3;
    e.state.searchDealtRound = 3;
    await finalizeSearchRound(e);
    expect(e.events).toHaveLength(6);
    expect(e.state.phase).toBe("DISCUSSION");
  });
});
