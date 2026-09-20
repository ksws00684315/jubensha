import { describe, expect, it } from "vitest";
import { searchLocationOptions } from "./search-locations";

describe("搜证地点选项", () => {
  const locations = [
    { id: "hall", name: "大厅", ownerCharacterId: undefined },
    { id: "room", name: "甲的房间", ownerCharacterId: "jia" },
    { id: "locked", name: "密室", ownerCharacterId: undefined },
  ] as never;
  const clues = [
    { id: "hall_clue", locationId: "hall", release: {} },
    { id: "locked_clue", locationId: "locked", release: { round: 2, afterCluePublicIds: ["prerequisite"] } },
  ] as never;

  it("区分本人房间、可搜、耗尽和未解锁地点", () => {
    expect(searchLocationOptions({
      locations,
      clues,
      clueStates: { hall_clue: { discoveredBy: 1, isPublic: false } },
      seatCharacterId: "jia",
      round: 1,
    })).toEqual([
      { name: "大厅", status: "exhausted", reason: "线索已搜完" },
      { name: "甲的房间", status: "own_room", reason: "这是你的房间" },
      { name: "密室", status: "locked", reason: "尚未满足线索开放条件" },
    ]);
  });

  it("前置材料公开后将地点标记为可搜", () => {
    expect(searchLocationOptions({ locations, clues, clueStates: { prerequisite: { discoveredBy: 0, isPublic: true } }, seatCharacterId: null, round: 2 })[2]).toEqual({ name: "密室", status: "available" });
  });
});
