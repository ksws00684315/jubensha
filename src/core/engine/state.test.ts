import { describe, expect, it } from "vitest";
import { cluesVisibleToSeat, initialState, renderEventLog, sanitizeEventContent, visibleTo } from "./state";
import type { EngineEvent } from "./types";

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

describe("事件内容脱敏", () => {
  it("不论新写入还是历史投影都不能带出 AI purpose", () => {
    expect(sanitizeEventContent({ text: "发言", speakerName: "角色", purpose: "culprit" })).toEqual({
      text: "发言",
      speakerName: "角色",
    });
  });
});

describe("线索转交事件的可见性与渲染", () => {
  const transferEvent = (fromSeat: number, toSeat: number): EngineEvent => ({
    seq: "1",
    type: "transfer",
    phase: "DISCUSSION",
    round: 1,
    fromSeat,
    toSeat,
    visibility: `seat:${toSeat}`,
    content: { clueId: "a", clueName: "银簪", clueContent: "抽屉深处的一支银簪", text: "悄悄把一张线索卡交给了你。" },
    createdAt: "",
  });

  it("收卡人看到「你收到」，转出方看到「你交出」，无关座位与观战不可见", () => {
    const ev = transferEvent(0, 1);
    expect(renderEventLog([ev], 1)).toContain("【线索转交】你收到「银簪」");
    expect(renderEventLog([ev], 1)).toContain("抽屉深处的一支银簪");
    expect(renderEventLog([ev], 0)).toContain("【线索转交】你交出「银簪」");
    expect(renderEventLog([ev], 2)).toBe("");
    expect(renderEventLog([ev], null)).toBe("");
    expect(visibleTo(ev, 1)).toBe(true);
    expect(visibleTo(ev, 0)).toBe(true);
    expect(visibleTo(ev, 2)).toBe(false);
  });

  it("未开票前只有投票者看见自己的票，公开计票全场可见", () => {
    const sealed = {
      seq: "1",
      type: "vote" as const,
      phase: "VOTE" as const,
      round: 1,
      fromSeat: 0,
      toSeat: null,
      visibility: "seat:0",
      content: { target: 1, text: "你投给了乙" },
      createdAt: "",
    };
    expect(visibleTo(sealed, 0)).toBe(true);
    expect(visibleTo(sealed, 1)).toBe(false);
    const tally = { ...sealed, fromSeat: null, visibility: "public", content: { counts: { "1": 2 }, text: "甲 投给 乙\n丙 投给 乙", tally: true } };
    expect(visibleTo(tally, 1)).toBe(true);
  });
});
