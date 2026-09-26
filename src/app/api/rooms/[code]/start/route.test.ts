import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { GameEngine } from "@/core/engine/engine";
import { roomRow, seatRow, scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
// start 只需引擎创建成功/抛错两种形态；真引擎模块图（LLM/定时器）与路由测试无关
vi.mock("@/core/engine/engine", () => ({
  GameEngine: { start: vi.fn(async () => ({ gameId: "game-new" })), get: vi.fn(() => null), load: vi.fn(async () => ({})) },
}));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

const CODE = "ABCDE";

function readyRoom(overrides: Record<string, unknown> = {}) {
  return roomRow({
    ...overrides,
    seats: [
      seatRow(),
      seatRow({ id: "seat-2", index: 1, kind: "ai", token: null, playerName: null, characterId: "suyu" }),
      seatRow({ id: "seat-3", index: 2, kind: "ai", token: null, playerName: null, characterId: "guchen" }),
    ],
  });
}

describe("A25 POST /api/rooms/[code]/start", () => {
  it("缺少房主凭证 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/rooms/${CODE}/start`, { body: {} }), ctx({ code: CODE }));
    expect(res.status).toBe(400);
  });

  it("房间不存在 → 404", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/rooms/${CODE}/start`, { body: { hostToken: "host-token-1" } }), ctx({ code: CODE }));
    expect(res.status).toBe(404);
  });

  it("错 hostToken → 403", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(readyRoom() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/rooms/${CODE}/start`, { body: { hostToken: "wrong" } }), ctx({ code: CODE }));
    expect(res.status).toBe(403);
  });

  it("已有对局 → 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(readyRoom() as never);
    vi.mocked(db.game.findUnique).mockResolvedValue({ id: "game-exists" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/rooms/${CODE}/start`, { body: { hostToken: "host-token-1" } }), ctx({ code: CODE }));
    expect(res.status).toBe(400);
  });

  it("真人座位未入座（无 token）→ 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(readyRoom({ seats: [seatRow({ token: null }), seatRow({ id: "seat-2", index: 1, kind: "ai", token: null, playerName: null, characterId: "suyu" }), seatRow({ id: "seat-3", index: 2, kind: "ai", token: null, playerName: null, characterId: "guchen" })] }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/rooms/${CODE}/start`, { body: { hostToken: "host-token-1" } }), ctx({ code: CODE }));
    expect(res.status).toBe(400);
  });

  it("成功 → 201 + gameId，room 状态置 playing", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(readyRoom() as never);
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.seat.update).mockResolvedValue(seatRow() as never);
    vi.mocked(db.room.update).mockResolvedValue(readyRoom() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/rooms/${CODE}/start`, { body: { hostToken: "host-token-1" } }), ctx({ code: CODE }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ gameId: "game-new" });
    expect(GameEngine.start).toHaveBeenCalled();
    expect(db.room.update).toHaveBeenCalledWith({ where: { id: "room-1" }, data: { status: "playing" } });
  });
});
