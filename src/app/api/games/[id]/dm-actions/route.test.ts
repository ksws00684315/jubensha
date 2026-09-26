import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { GameEngine } from "@/core/engine/engine";
import { gameRow, seatRow, scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/engine/engine", () => ({
  GameEngine: { get: vi.fn(() => null), load: vi.fn(async () => ({})) },
}));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  vi.mocked(GameEngine.get).mockReset().mockReturnValue(null as never);
  vi.mocked(GameEngine.load).mockReset().mockResolvedValue({} as never);
});

const ID = "game-1";

function dmGame(overrides: Record<string, unknown> = {}) {
  return gameRow({
    id: ID,
    votes: [],
    scriptSnapshot: null,
    script: scriptRow(),
    room: {
      id: "room-1",
      code: "ABCDE",
      humanDm: true,
      dmToken: "dm-token-1",
      seats: [seatRow({ index: 0, characterId: "linhai" })],
    },
    ...overrides,
  });
}

describe("A31 POST /api/games/[id]/dm-actions", () => {
  it("参数不合法：未知 type → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", `/api/games/${ID}/dm-actions`, { body: { token: "dm-token-1", action: { type: "self_destruct" } } }),
      ctx({ id: ID })
    );
    expect(res.status).toBe(400);
  });

  it("对局不存在 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", `/api/games/${ID}/dm-actions`, { body: { token: "dm-token-1", action: { type: "narrate", text: "旁白" } } }),
      ctx({ id: ID })
    );
    expect(res.status).toBe(404);
  });

  it("非 DM 凭证 → 403（abort_game 同样需要 DM 凭证）", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(dmGame() as never);
    const { POST } = await import("./route");
    for (const type of ["narrate", "abort_game"]) {
      const res = await POST(
        makeReq("POST", `/api/games/${ID}/dm-actions`, { body: { token: "wrong", action: { type, text: "x" } } }),
        ctx({ id: ID })
      );
      expect(res.status).toBe(403);
    }
  });

  it("DM 合法 → 引擎 handleDmAction 被调用", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(dmGame() as never);
    const handleDmAction = vi.fn(async () => ({ ok: true }));
    vi.mocked(GameEngine.get).mockReset().mockReturnValue({ handleDmAction } as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", `/api/games/${ID}/dm-actions`, { body: { token: "dm-token-1", action: { type: "narrate", text: "夜幕降临" } } }),
      ctx({ id: ID })
    );
    expect(res.status).toBe(200);
    expect(handleDmAction).toHaveBeenCalledWith({ type: "narrate", text: "夜幕降临" });
  });
});

describe("A32 GET /api/games/[id]/dm-actions", () => {
  it("对局不存在 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/games/${ID}/dm-actions?token=x`), ctx({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("非 DM → 403，拿不到 truth", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(dmGame() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/games/${ID}/dm-actions?token=wrong`), ctx({ id: ID }));
    expect(res.status).toBe(403);
  });

  it("DM 凭证正确 → 返回 truth 与角色私卡", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(dmGame({ votes: [] }) as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/games/${ID}/dm-actions?token=dm-token-1`), ctx({ id: ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truth.culprit).toBeTruthy();
    expect(body.structured.characters[0].privateCard).toBeTruthy();
    expect(body.structured.clues.length).toBeGreaterThan(0);
  });
});
