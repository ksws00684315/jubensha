import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { roomRow, seatRow, scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

function lobbyRoom(overrides: Record<string, unknown> = {}) {
  return roomRow({
    ...overrides,
    seats: [seatRow(), seatRow({ id: "seat-2", index: 1, kind: "ai", token: null, playerName: null }), seatRow({ id: "seat-3", index: 2, kind: "ai", token: null, playerName: null })],
  });
}

describe("A23 GET /api/rooms/[code]", () => {
  it("房间不存在 → 404", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(null as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/rooms/ZZZZZ"), ctx({ code: "ZZZZZ" }));
    expect(res.status).toBe(404);
  });

  it("返回座位但绝不包含 token 字段", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/rooms/ABCDE?hostToken=host-token-1"), ctx({ code: "ABCDE" }));
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("seat-token-1");
    expect(raw).not.toContain("host-token-1");
    expect(raw).not.toContain('"token"');
  });

  it("无凭证时 gameId 为 null（不泄露对局枚举入口）", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom({ game: { id: "game-9", status: "running", phase: "DISCUSSION" } }) as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/rooms/ABCDE"), ctx({ code: "ABCDE" }));
    const body = await res.json();
    expect(body.gameId).toBeNull();
  });

  it("限流 429", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await GET(makeReq("GET", "/api/rooms/ABCDE", { headers: { "x-forwarded-for": "10.2.2.2" } }), ctx({ code: "ABCDE" }));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("A24 PATCH /api/rooms/[code]", () => {
  const payload = {
    hostToken: "host-token-1",
    seats: [
      { index: 0, kind: "human" },
      { index: 1, kind: "ai" },
      { index: 2, kind: "ai" },
    ],
  };

  it("房间不存在 → 404", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(null as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/rooms/ABCDE", { body: payload }), ctx({ code: "ABCDE" }));
    expect(res.status).toBe(404);
  });

  it("错 hostToken → 403", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/rooms/ABCDE", { body: { ...payload, hostToken: "wrong" } }), ctx({ code: "ABCDE" }));
    expect(res.status).toBe(403);
  });

  it("非大厅状态 → 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom({ status: "playing" }) as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/rooms/ABCDE", { body: payload }), ctx({ code: "ABCDE" }));
    expect(res.status).toBe(400);
  });

  it("改成 AI 座位后 token 置 null（事务内 update 数据）", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.seat.update).mockResolvedValue(seatRow() as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/rooms/ABCDE", { body: payload }), ctx({ code: "ABCDE" }));
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalled();
    const aiCall = vi.mocked(db.seat.update).mock.calls.find((c) => (c[0] as { where: { id: string } }).where.id === "seat-2");
    expect(aiCall).toBeTruthy();
    const data = aiCall![0] as unknown as { data: { kind: string; token: string | null } };
    expect(data.data.kind).toBe("ai");
    expect(data.data.token).toBeNull();
  });
});
