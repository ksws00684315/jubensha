import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, publishMock } = vi.hoisted(() => ({
  dbMock: {
    gameEvent: { create: vi.fn() },
    game: { update: vi.fn() },
    $transaction: vi.fn(),
  },
  publishMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("./bus", () => ({ publish: publishMock }));

import { appendEvent, initialState } from "./state";

describe("原子追加事件与快照", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("事务成功后才发布事件", async () => {
    const order: string[] = [];
    const row = {
      seq: BigInt(7),
      type: "system",
      phase: "READING",
      round: 0,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { text: "快照与事件一同提交" },
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
    };
    dbMock.gameEvent.create.mockResolvedValue(row);
    dbMock.game.update.mockResolvedValue({});
    dbMock.$transaction.mockImplementation(async (operations: Promise<unknown>[]) => {
      order.push("transaction");
      const results = await Promise.all(operations);
      order.push("resolved");
      return results;
    });
    publishMock.mockImplementation(() => order.push("publish"));

    const snapshot = initialState([]);
    await appendEvent("game-1", {
      type: "system",
      phase: "READING",
      round: 0,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { text: "快照与事件一同提交" },
    }, snapshot);

    expect(dbMock.$transaction).toHaveBeenCalledOnce();
    expect(dbMock.game.update).toHaveBeenCalledWith({
      where: { id: "game-1" },
      data: { state: snapshot, phase: "LOBBY", round: 0 },
    });
    expect(order).toEqual(["transaction", "resolved", "publish"]);
  });
});
