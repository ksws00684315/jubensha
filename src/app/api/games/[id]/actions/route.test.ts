import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { GameEngine } from "@/core/engine/engine";
import { gameRow, seatRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/engine/engine", () => ({
  GameEngine: {
    get: vi.fn(() => null),
    load: vi.fn(async () => ({})),
    // handleAction 由各用例按需配置
  },
}));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

const ID = "game-1";

function gameWithSeats() {
  return gameRow({
    id: ID,
    room: {
      id: "room-1",
      code: "ABCDE",
      humanDm: false,
      dmToken: null,
      seats: [seatRow({ index: 0 }), seatRow({ id: "seat-2", index: 1, kind: "ai", token: "ai-token", playerName: null })],
    },
  });
}

function actionReq(overrides: Record<string, unknown> = {}) {
  return makeReq("POST", `/api/games/${ID}/actions`, {
    body: { seatIndex: 0, token: "seat-token-1", action: { type: "speak", text: "发言" }, ...overrides },
  });
}

describe("A30 POST /api/games/[id]/actions", () => {
  it("参数不合法：未知 type → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/games/${ID}/actions`, { body: { seatIndex: 0, token: "t", action: { type: "explode" } } }), ctx({ id: ID }));
    expect(res.status).toBe(400);
  });

  it("对局不存在 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(actionReq(), ctx({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("错 token → 403", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameWithSeats() as never);
    const { POST } = await import("./route");
    const res = await POST(actionReq({ token: "wrong" }), ctx({ id: ID }));
    expect(res.status).toBe(403);
  });

  it("load 抛错 → 503 可重试文案", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameWithSeats() as never);
    vi.mocked(GameEngine.get).mockReturnValue(null as never);
    vi.mocked(GameEngine.load).mockRejectedValue(new Error("corrupt snapshot") as never);
    const { POST } = await import("./route");
    const res = await POST(actionReq(), ctx({ id: ID }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "对局状态暂时无法恢复，请稍后重试" });
  });

  it("engine ok → 200；engine 拒绝 → 400（不改写引擎错误文案）", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameWithSeats() as never);
    vi.mocked(GameEngine.get).mockReturnValue(null as never);
    vi.mocked(GameEngine.load).mockResolvedValue({ handleAction: vi.fn(async () => ({ ok: true })) } as never);
    const { POST } = await import("./route");
    const okRes = await POST(actionReq(), ctx({ id: ID }));
    expect(okRes.status).toBe(200);

    vi.mocked(GameEngine.load).mockResolvedValue({ handleAction: vi.fn(async () => ({ ok: false, error: "还没轮到你" })) } as never);
    const badRes = await POST(actionReq(), ctx({ id: ID }));
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toEqual({ ok: false, error: "还没轮到你" });
  });

  it("超长文本原样进入引擎（截断发生在引擎层）", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameWithSeats() as never);
    const handleAction = vi.fn(async () => ({ ok: true }));
    vi.mocked(GameEngine.get).mockReturnValue({ handleAction } as never);
    const { POST } = await import("./route");
    const longText = "长".repeat(2000);
    await POST(actionReq({ action: { type: "speak", text: longText } }), ctx({ id: ID }));
    expect(handleAction).toHaveBeenCalledWith(0, expect.objectContaining({ type: "speak", text: longText }));
  });

  it("限流：第 61 次/分钟 → 429", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await POST(makeReq("POST", `/api/games/${ID}/actions`, { body: { seatIndex: 0, token: "t", action: { type: "ready" } }, headers: { "x-forwarded-for": "10.4.4.4" } }), ctx({ id: ID }));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });
});
