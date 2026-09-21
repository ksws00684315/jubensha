import { describe, it, expect } from "vitest";
import { duplicateQuestion, bigramSimilarity } from "./questions";
import type { EngineEvent } from "./types";
const question: EngineEvent = { seq: "1", createdAt: "", type: "speech", phase: "DISCUSSION", round: 1, fromSeat: 0, toSeat: 1, visibility: "public", content: { questionId: "q1", question: "已知服药为何仍然催酒？", evidenceIds: ["a"] } };
describe("全场质询去重", () => {
  it("不同提问者对同一目标和同组证据只能提问一次", () => {
    expect(duplicateQuestion([question], 1, 1, "换个说法继续追问", ["a"])).toBe(true);
    expect(duplicateQuestion([question], 2, 1, "换个说法继续追问", ["a"])).toBe(false);
  });
  it("无证据时规范化中文二元组比较；新增公开证据允许追问", () => {
    expect(bigramSimilarity("你为什么催酒？", "你为什么催酒！")).toBe(1);
    expect(duplicateQuestion([question], 1, 1, "已知服药为何仍然催酒！", [])).toBe(true);
    const clue: EngineEvent = { ...question, seq: "2", type: "clue", content: { clueId: "b" } };
    expect(duplicateQuestion([question, clue], 1, 1, "已知服药为何仍然催酒！", ["a", "b"])).toBe(false);
  });
});
