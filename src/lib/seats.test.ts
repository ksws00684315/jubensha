import { describe, expect, it } from "vitest";
import { assignCharacterIds, hasDuplicateCharacterIds } from "./seats";

describe("assignCharacterIds", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("全部自动分配时每人角色不同，且是角色表的一个排列", () => {
    const seats = ids.map(() => ({ kind: "ai", characterId: null }));
    const assigned = assignCharacterIds(seats, ids);
    expect([...assigned].sort()).toEqual([...ids].sort());
    expect(hasDuplicateCharacterIds(assigned)).toBe(false);
  });

  it("剩余角色池默认打乱（D-1）：多次分配不全等于顺序表", () => {
    const seats = ids.map(() => ({ kind: "ai", characterId: null }));
    const outcomes = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      outcomes.add(assignCharacterIds(seats, ids).join(","));
    }
    // 5! = 120 种排列，40 次全命中顺序表的概率约 (1/120)^39 ≈ 0
    expect(outcomes.size).toBeGreaterThan(1);
    expect(outcomes.has(ids.join(","))).toBe(true); // 顺序表本身也是合法排列之一
  });

  it("注入确定性洗牌时按洗牌结果分配（T4.3）", () => {
    const seats = ids.map(() => ({ kind: "ai", characterId: null }));
    const assigned = assignCharacterIds(seats, ids, (items) => [...items].reverse());
    expect(assigned).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("部分指定时补齐剩余且不重复，指定的保留", () => {
    const seats = [
      { kind: "human", characterId: "c" },
      { kind: "ai", characterId: null },
      { kind: "ai", characterId: null },
    ];
    // 恒等洗牌让补齐结果可断言：剩余池为 a/b/d/e，按序填入两个空位
    const assigned = assignCharacterIds(seats, ids, (items) => items);
    expect(assigned[0]).toBe("c");
    expect(assigned.slice(1)).toEqual(["a", "b"]);
    expect(hasDuplicateCharacterIds(assigned)).toBe(false);
  });

  it("空座不占角色", () => {
    const seats = [
      { kind: "ai", characterId: null },
      { kind: "empty", characterId: null },
      { kind: "ai", characterId: null },
    ];
    const assigned = assignCharacterIds(seats, ids, (items) => items);
    expect(assigned).toEqual(["a", null, "b"]);
  });
});
