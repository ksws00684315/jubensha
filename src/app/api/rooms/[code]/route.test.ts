import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, resetRateLimits, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";
import { roomRow, seatRow, scriptRow } from "@/test/fixtures";
import { publish } from "@/core/engine/bus";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/engine/bus", () => ({ publish: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

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

  it("occupancy：AI 座位与已认领真人座位计入 filled，空座只计入 total（R2/T5.2）", async () => {
    // seat 0 真人已认领（有 token），seat 1/2 为 AI；再加一个未认领真人与空座
    vi.mocked(db.room.findUnique).mockResolvedValue(
      roomRow({
        seats: [
          seatRow(),
          seatRow({ id: "seat-2", index: 1, kind: "ai", token: null, playerName: null }),
          seatRow({ id: "seat-3", index: 2, kind: "ai", token: null, playerName: null }),
          seatRow({ id: "seat-4", index: 3, kind: "human", token: null, playerName: null }),
          seatRow({ id: "seat-5", index: 4, kind: "empty", token: null, playerName: null, characterId: null }),
        ],
      }) as never,
    );
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/rooms/ABCDE"), ctx({ code: "ABCDE" }));
    const body = await res.json();
    expect(body.occupancy).toEqual({ filled: 3, total: 4 });
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

  it("事务成功后才吊销被改成非真人座位的旧流", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom({ game: { id: "running-game" } }) as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.seat.update).mockResolvedValue(seatRow() as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/rooms/ABCDE", {
      body: { ...payload, seats: [{ index: 0, kind: "ai" }, ...payload.seats.slice(1)] },
    }), ctx({ code: "ABCDE" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(db.$transaction).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(publish).mock.invocationCallOrder[0]);
    expect(publish).toHaveBeenCalledWith("running-game", { kind: "revoke", seat: 0 });
  });
});

/**
 * S3.1：把真人座改成 AI 座与建 AI 房花同样的钱，所以 PATCH 要按「改完的结果」再查一遍授权。
 * 无权限用例同样要 stub NODE_ENV=production —— 测试环境的「本机免登录」会把 localhost 请求当作管理员。
 */
describe("A24 PATCH /api/rooms/[code] —— S3.1 开房授权策略", () => {
  const seatsWithAi = [
    { index: 0, kind: "human" },
    { index: 1, kind: "ai" },
    { index: 2, kind: "ai" },
  ];
  const allHuman = [
    { index: 0, kind: "human" },
    { index: 1, kind: "human" },
    { index: 2, kind: "human" },
  ];

  function stubPatchOk() {
    vi.mocked(db.room.findUnique).mockResolvedValue(lobbyRoom() as never);
    vi.mocked(db.script.findUnique).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.seat.update).mockResolvedValue(seatRow() as never);
  }

  async function patch(seats: Record<string, unknown>[], extra: Record<string, unknown> = {}, headers?: Record<string, string>) {
    const { PATCH } = await import("./route");
    return PATCH(
      makeReq("PATCH", "/api/rooms/ABCDE", { body: { hostToken: "host-token-1", seats, ...extra }, headers }),
      ctx({ code: "ABCDE" })
    );
  }

  it("策略 admin：无凭证改出 AI 座位 → 403，座位不落库", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubPatchOk();
    const res = await patch(seatsWithAi);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("创建含 AI 座位的房间需要管理员身份");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("默认策略：生产环境为 admin，无凭证改出 AI 座位被拒", async () => {
    stubProduction();
    stubPatchOk();
    const res = await patch(seatsWithAi);
    expect(res.status).toBe(403);
  });

  it("策略 admin：管理员口令可改出 AI 座位", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubPatchOk();
    const res = await patch(seatsWithAi, {}, adminHeaders());
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalled();
  });

  it("策略 open：无凭证可改出 AI 座位", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "open");
    stubPatchOk();
    const res = await patch(seatsWithAi);
    expect(res.status).toBe(200);
  });

  it("策略 admin：改完全真人座位不需要授权", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubPatchOk();
    const res = await patch(allHuman);
    expect(res.status).toBe(200);
  });

  it("策略 invite：邀请码正确可改出 AI 座位", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "invite-code-for-test");
    stubPatchOk();
    const res = await patch(seatsWithAi, { inviteCode: "invite-code-for-test" });
    expect(res.status).toBe(200);
  });

  it("策略 invite：邀请码错误 → 403", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "invite-code-for-test");
    stubPatchOk();
    const res = await patch(seatsWithAi, { inviteCode: "wrong" });
    expect(res.status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("策略 invite：缺 ROOM_INVITE_CODE 时 fail closed", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "");
    stubPatchOk();
    const res = await patch(seatsWithAi, { inviteCode: "whatever" });
    expect(res.status).toBe(403);
  });

  it("房主校验仍然优先：hostToken 错时不给授权提示", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubPatchOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(
      makeReq("PATCH", "/api/rooms/ABCDE", { body: { hostToken: "wrong", seats: seatsWithAi } }),
      ctx({ code: "ABCDE" })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("只有房主可以改座位");
  });
});
