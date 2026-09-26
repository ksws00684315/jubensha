import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { roomRow, seatRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

function lobbyRoom() {
  return roomRow({
    seats: [
      seatRow(),
      seatRow({ id: "seat-2", index: 1, kind: "human", token: null, playerName: null, characterId: "suyu" }),
      seatRow({ id: "seat-3", index: 2, kind: "ai", token: null, playerName: null, characterId: "guchen" }),
    ],
  });
}

describe("A26 POST /api/rooms/join", () => {
  it("参数不合法 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "A" } }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("房间不存在 → 404", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ZZZZZ", name: "小明" } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("同名歧义 → ambiguous 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(
      roomRow({ seats: [seatRow({ id: "s1", playerName: "小明" }), seatRow({ id: "s2", index: 1, kind: "human", token: null, playerName: "小明" }), seatRow({ id: "s3", index: 2, kind: "ai", token: null, playerName: null })] }) as never
    );
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ABCDE", name: "小明" } }), ctx({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("多个座位") });
  });

  it("无 token 冒名已占昵称 → taken 403", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ABCDE", name: "玩家一" } }), ctx({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("已被占用") });
  });

  it("持旧 token → resume 并换发新 token", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.seat.update).mockResolvedValue(seatRow() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ABCDE", name: "玩家一", token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.token).not.toBe("seat-token-1");
  });

  it("满员 → full 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(roomRow({ seats: [seatRow(), seatRow({ id: "s2", index: 1, kind: "human", playerName: "乙", characterId: "suyu" }), seatRow({ id: "s3", index: 2, kind: "human", playerName: "丙", characterId: "guchen" })] }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ABCDE", name: "新人" } }), ctx({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("已满") });
  });

  it("并发抢座 updateMany count=0 → 认领失败，最终满员 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.seat.updateMany).mockResolvedValue({ count: 0 } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ABCDE", name: "新人" } }), ctx({}));
    expect(res.status).toBe(400);
    expect(db.seat.updateMany).toHaveBeenCalledTimes(1); // 唯一空座抢不到即满员
  });

  it("正常入座 → 200 + seatIndex + token", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.seat.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.seat.findUnique).mockResolvedValue(seatRow({ id: "seat-2", playerName: "新人" }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ABCDE", name: "新人" } }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.seatIndex).toBe(0);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("限流：第 11 次/分钟 → 429", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await POST(makeReq("POST", "/api/rooms/join", { body: { code: "ZZZZZ", name: "x" }, headers: { "x-forwarded-for": "10.3.3.3" } }), ctx({}));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });
});
