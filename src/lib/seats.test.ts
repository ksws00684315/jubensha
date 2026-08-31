import { describe, expect, it } from "vitest";
import { assignCharacterIds, hasDuplicateCharacterIds } from "./seats";

describe("assignCharacterIds", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("全部自动分配时每人角色不同", () => {
    const seats = ids.map(() => ({ kind: "ai", characterId: null }));
    const assigned = assignCharacterIds(seats, ids);
    expect(assigned).toEqual(ids);
    expect(hasDuplicateCharacterIds(assigned)).toBe(false);
  });

  it("部分指定时补齐剩余且不重复", () => {
    const seats = [
      { kind: "human", characterId: "c" },
      { kind: "ai", characterId: null },
      { kind: "ai", characterId: null },
    ];
    const assigned = assignCharacterIds(seats, ids);
    expect(assigned[0]).toBe("c");
    expect(new Set(assigned).size).toBe(3);
  });

  it("空座不占角色", () => {
    const seats = [
      { kind: "ai", characterId: null },
      { kind: "empty", characterId: null },
      { kind: "ai", characterId: null },
    ];
    const assigned = assignCharacterIds(seats, ids);
    expect(assigned).toEqual(["a", null, "b"]);
  });
});
