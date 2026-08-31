import { describe, expect, it } from "vitest";
import { cluesVisibleToSeat, initialState } from "./state";

describe("cluesVisibleToSeat", () => {
  const clues = [
    { id: "a", name: "A", location: "书房" },
    { id: "b", name: "B", location: "卧室" },
    { id: "c", name: "C", location: "花园" },
  ];

  it("未发现的线索不下发", () => {
    const state = initialState([]);
    expect(cluesVisibleToSeat(clues, state, 0)).toEqual([]);
  });

  it("自己持有或已公开的才可见", () => {
    const state = initialState([]);
    state.clueStates.a = { discoveredBy: 0, isPublic: false };
    state.clueStates.b = { discoveredBy: 1, isPublic: true };
    state.clueStates.c = { discoveredBy: 1, isPublic: false };
    state.heldClues[0] = ["a"];
    const visible = cluesVisibleToSeat(clues, state, 0);
    expect(visible.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});
