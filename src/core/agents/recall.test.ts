import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { embedTexts, resolveBinding } from "@/core/llm/client";
import type { EngineEvent } from "@/core/engine/types";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { recallRelevantStatements } from "./recall";

vi.mock("@/lib/db", () => ({ db: { eventVector: { findMany: vi.fn() } } }));
vi.mock("@/core/llm/client", () => ({
  embedTexts: vi.fn(),
  embeddingSpaceId: vi.fn(() => "space-1"),
  resolveBinding: vi.fn(),
}));

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

function speech(seq: string, text: string, overrides: Partial<EngineEvent> = {}): EngineEvent {
  return {
    seq,
    type: "speech",
    phase: "DISCUSSION",
    round: 1,
    fromSeat: 3,
    toSeat: null,
    visibility: "public",
    content: { text, speakerName: "白慕森" },
    createdAt: "2026-09-18T21:00:00.000Z",
    ...overrides,
  };
}

function cluePublicEvent(seq: string, clueId: string): EngineEvent {
  return {
    seq,
    type: "clue",
    phase: "DISCUSSION",
    round: 1,
    fromSeat: 1,
    toSeat: null,
    visibility: "public",
    content: { clueId, clueName: doc.clues.find((c) => c.id === clueId)?.name ?? clueId },
    createdAt: "2026-09-18T21:00:00.000Z",
  };
}

const findMany = vi.mocked(db.eventVector.findMany);
const mockBinding = vi.mocked(resolveBinding);
const mockEmbed = vi.mocked(embedTexts);

describe("recallRelevantStatements 向量检索记忆层", () => {
  beforeEach(() => vi.clearAllMocks());

  it("缺少锚点或空查询直接返回空", async () => {
    expect(await recallRelevantStatements({ gameId: "g", events: [speech("1", "话")], seatIndex: 0, anchorSeq: "", query: "x" })).toEqual([]);
    expect(await recallRelevantStatements({ gameId: "g", events: [speech("1", "话")], seatIndex: 0, anchorSeq: "5", query: "   " })).toEqual([]);
  });

  it("embedding 未绑定时仍可精确回查公开线索（含标题命中）", async () => {
    mockBinding.mockResolvedValueOnce(null as never);
    const events = [cluePublicEvent("4", "teacup"), speech("6", "茶是周伯端进去的")];
    const lines = await recallRelevantStatements({ gameId: "g", events, seatIndex: 0, anchorSeq: "9", query: "我想谈谈参茶残液的事", script: doc });
    expect(lines).toHaveLength(1);
    expect(lines[0].label).toContain("参茶残液");
    expect(lines[0].sourceSeq).toBe("4");
    expect(findMany).not.toHaveBeenCalled(); // 无绑定不进向量检索
  });

  it("按余弦相似度注入旧发言，低于阈值/缺向量的候选不注入", async () => {
    mockBinding.mockResolvedValueOnce({ slot: "embedding" } as never);
    findMany.mockResolvedValueOnce([
      { seq: BigInt(2), vector: [1, 0], dimension: 2 },
      { seq: BigInt(3), vector: [0, 1], dimension: 2 }, // 正交 → 相似度 0，低于 0.45
    ] as never);
    mockEmbed.mockResolvedValueOnce([[1, 0]] as never);
    const events = [speech("2", "我八点五十八就离开了书房"), speech("3", "雪地脚印跟我无关"), speech("4", "这条没有向量行")];
    const lines = await recallRelevantStatements({ gameId: "g", events, seatIndex: 0, anchorSeq: "9", query: "白慕森离开书房的时间" });
    expect(lines.map((l) => l.sourceSeq)).toEqual(["2"]);
    expect(lines[0].label).toContain("白慕森");
  });

  it("维度不匹配的向量行被丢弃（换 embedding 模型后旧向量不误用）", async () => {
    mockBinding.mockResolvedValueOnce({ slot: "embedding" } as never);
    findMany.mockResolvedValueOnce([{ seq: BigInt(2), vector: [1, 0, 0], dimension: 2 }] as never); // dimension 与长度不符
    mockEmbed.mockResolvedValueOnce([[1, 0]] as never);
    const lines = await recallRelevantStatements({ gameId: "g", events: [speech("2", "话")], seatIndex: 0, anchorSeq: "9", query: "q" });
    expect(lines).toEqual([]);
  });

  it("命中封顶 TOP_K=3，且按相似度降序", async () => {
    mockBinding.mockResolvedValueOnce({ slot: "embedding" } as never);
    findMany.mockResolvedValueOnce(
      [
        { seq: BigInt(1), vector: [1, 0], dimension: 2 },
        { seq: BigInt(2), vector: [1, 0], dimension: 2 },
        { seq: BigInt(3), vector: [1, 0], dimension: 2 },
        { seq: BigInt(4), vector: [1, 0], dimension: 2 },
      ] as never
    );
    mockEmbed.mockResolvedValueOnce([[1, 0]] as never);
    const events = [1, 2, 3, 4].map((i) => speech(String(i), `发言 ${i}`));
    const lines = await recallRelevantStatements({ gameId: "g", events, seatIndex: 0, anchorSeq: "9", query: "q" });
    expect(lines).toHaveLength(3);
  });

  it("锚点之后的发言与不可见事件不参与检索；纯观战只见 public", async () => {
    mockBinding.mockResolvedValueOnce({ slot: "embedding" } as never);
    const events = [speech("10", "锚点之后的发言"), speech("5", "别人的私信", { visibility: "seat:2", fromSeat: 2 })];
    // seat:2 的事件对座位 0 不可见，seq 10 在锚点后 → 候选清空，早退且不查库
    const asSeat0 = await recallRelevantStatements({ gameId: "g", events, seatIndex: 0, anchorSeq: "9", query: "q" });
    expect(asSeat0).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
