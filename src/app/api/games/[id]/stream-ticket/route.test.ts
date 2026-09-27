import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { consumeStreamTicket, STREAM_TICKET_TTL_MS } from "@/lib/stream-tickets";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

const mockFindGame = vi.mocked(db.game.findUnique);

const GAME_ID = "ticket-game-1";

function gameRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GAME_ID,
    status: "running",
    room: {
      humanDm: true,
      dmToken: "dm-1",
      hostToken: "host-1",
      seats: [
        { index: 0, token: "tok-0" },
        { index: 1, token: "tok-1" },
      ],
    },
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("./route");
  const req = makeReq("POST", `/api/games/${GAME_ID}/stream-ticket`, { body, headers });
  const res = await POST(req, ctx({ id: GAME_ID }));
  return { res, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("A37 POST /api/games/[id]/stream-ticket（SSE 一次性票据签发）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimits();
    mockFindGame.mockResolvedValue(gameRow() as never);
  });

  it("座位凭证正确 → 签发 60 秒票据，票据绑定该座位且只能用一次", async () => {
    const { status, data } = await post({ seat: 0 }, { "x-seat-token": "tok-0" });
    expect(status).toBe(200);
    expect(String(data.ticket)).toMatch(/^[0-9a-f]{32}$/);
    expect(Number(data.expiresAt) - Date.now()).toBeGreaterThan(STREAM_TICKET_TTL_MS - 5_000);

    const principal = consumeStreamTicket(GAME_ID, String(data.ticket));
    expect(principal).toEqual({ kind: "seat", seat: 0, credential: "tok-0" });
    // 一次性：取出即作废，第二次不再返回主体
    expect(consumeStreamTicket(GAME_ID, String(data.ticket))).toBeNull();
  });

  it("真人主持凭证正确 → 签发 dm 主体", async () => {
    const { status, data } = await post({ dm: true }, { "x-dm-token": "dm-1" });
    expect(status).toBe(200);
    expect(consumeStreamTicket(GAME_ID, String(data.ticket))).toEqual({ kind: "dm", credential: "dm-1" });
  });

  it("缺凭证、错凭证、凭证与座位不符都被拒，且不签发票据", async () => {
    for (const [body, headers] of [
      [{ seat: 0 }, {}],
      [{ seat: 0 }, { "x-seat-token": "wrong" }],
      [{ seat: 1 }, { "x-seat-token": "tok-0" }], // tok-0 只能换 0 号的票
      [{ dm: true }, { "x-dm-token": "tok-0" }], // 座位 token 不能当 DM 用
      [{}, { "x-seat-token": "tok-0" }], // 没声明视角
      [{ dm: true }, {}],
    ] as const) {
      const { status, data } = await post(body, headers);
      expect(status).toBe(403);
      expect(data.ticket).toBeUndefined();
    }
  });

  it("未启用真人主持的房间不能换 DM 票", async () => {
    mockFindGame.mockResolvedValueOnce(gameRow({ room: { humanDm: false, dmToken: "dm-1", seats: [] } }) as never);
    expect((await post({ dm: true }, { "x-dm-token": "dm-1" })).status).toBe(403);
  });

  it("视角参数不合法 → 400", async () => {
    for (const body of [{ seat: 99 }, { seat: -1 }, { seat: "0" }, { dm: "yes" }]) {
      expect((await post(body, { "x-seat-token": "tok-0" })).status).toBe(400);
    }
  });

  it("对局不存在 → 404", async () => {
    mockFindGame.mockResolvedValueOnce(null as never);
    expect((await post({ seat: 0 }, { "x-seat-token": "tok-0" })).status).toBe(404);
  });

  it("换票接口限流：同 IP 一分钟内第 31 次返回 429 并带 Retry-After", async () => {
    const headers = { "x-seat-token": "tok-0", "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 30; i++) expect((await post({ seat: 0 }, headers)).status).toBe(200);
    const { status, data, res } = await post({ seat: 0 }, headers);
    expect(status).toBe(429);
    expect(data.ticket).toBeUndefined();
    expect(data.error).toEqual(expect.any(String));
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("响应体不外泄凭证明文", async () => {
    const ok = await post({ seat: 0 }, { "x-seat-token": "tok-0" });
    expect(JSON.stringify(ok.data)).not.toContain("tok-0");
    const denied = await post({ seat: 0 }, { "x-seat-token": "wrong" });
    expect(JSON.stringify(denied.data)).not.toContain("tok-0");
  });
});
