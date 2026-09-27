import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, resetRateLimits, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";
import { scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

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

const seats3 = [
  { kind: "human", characterId: "linhai" },
  { kind: "ai", characterId: "suyu" },
  { kind: "ai", characterId: "guchen" },
];

const aiSeats = [
  { kind: "ai", characterId: "linhai" },
  { kind: "ai", characterId: "suyu" },
  { kind: "ai", characterId: "guchen" },
];

const humanSeats = [
  { kind: "human", characterId: "linhai" },
  { kind: "human", characterId: "suyu" },
  { kind: "human", characterId: "guchen" },
];

describe("A22 POST /api/rooms", () => {
  it("座位数 < 3 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: [] } }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("座位数 > 8 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: Array.from({ length: 9 }, () => ({ kind: "human" })) } }),
      ctx({})
    );
    expect(res.status).toBe(400);
  });

  it("剧本不存在 → 404", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "ghost", seats: seats3 } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("角色重复 → 400", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/rooms", {
        body: { scriptId: "script-1", seats: [{ kind: "human", characterId: "linhai" }, { kind: "ai", characterId: "linhai" }, { kind: "ai", characterId: "suyu" }] },
      }),
      ctx({})
    );
    expect(res.status).toBe(400);
  });

  it("创建成功 → 201 + hostToken 为 32 位 hex", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-1", code: "ABCDE" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: seats3 } }), ctx({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hostToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.code).toBe("ABCDE");
  });

  it("P2002 撞码重试后成功", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create)
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }) as never)
      .mockResolvedValue({ id: "room-2", code: "FGHJK" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: seats3 } }), ctx({}));
    expect(res.status).toBe(201);
    expect(db.room.create).toHaveBeenCalledTimes(2);
  });

  it("限流：同 IP 第 6 个/分钟 → 429 + Retry-After", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-x", code: "ZZZZZ" } as never);
    const { POST } = await import("./route");
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await POST(
        makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: seats3 }, headers: { "x-forwarded-for": "10.9.9.9" } }),
        ctx({})
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });

  it("生产环境默认按 admin：管理员可创建含 AI 座位的房间", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-ai", code: "AAAAA" } as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/rooms", { headers: adminHeaders(), body: { scriptId: "script-1", seats: aiSeats } }),
      ctx({})
    );
    expect(res.status).toBe(201);
  });
});

/**
 * S3.1 开房授权策略（决策 D2）。
 *
 * 无权限用例必须在 NODE_ENV=production 下断言：开发/测试环境有「本机免登录」便利，
 * `makeReq` 的 Host 就是 localhost，任何请求都会被当作管理员。
 */
describe("A22 POST /api/rooms —— S3.1 开房授权策略", () => {
  const body = (seats: { kind: string; characterId: string }[], extra: Record<string, unknown> = {}) => ({
    scriptId: "script-1",
    seats,
    ...extra,
  });

  function stubCreateOk() {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-policy", code: "POLCY" } as never);
  }

  async function post(opts: { headers?: Record<string, string>; body?: Record<string, unknown> } = {}) {
    const { POST } = await import("./route");
    return POST(makeReq("POST", "/api/rooms", { body: opts.body ?? body(aiSeats), headers: opts.headers }), ctx({}));
  }

  it("策略 open：无凭证可创建含 AI 座位的房间", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "open");
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(201);
  });

  it("策略 open：带管理员凭证同样可创建（凭证不是必要条件）", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "open");
    stubCreateOk();
    const res = await post({ headers: adminHeaders() });
    expect(res.status).toBe(201);
  });

  it("默认策略：非生产环境为 open，无凭证可创建", async () => {
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(201);
  });

  it("默认策略：生产环境为 admin，无凭证被拒", async () => {
    stubProduction();
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(403);
    expect(db.room.create).not.toHaveBeenCalled();
  });

  it("策略 admin：管理员口令可创建", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubCreateOk();
    const res = await post({ headers: adminHeaders() });
    expect(res.status).toBe(201);
  });

  it("策略 admin：无凭证 → 403 与固定文案，且不落库", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("创建含 AI 座位的房间需要管理员身份");
    expect(db.room.create).not.toHaveBeenCalled();
  });

  it("策略 admin：纯真人房不受策略约束，无凭证可创建", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubCreateOk();
    const res = await post({ body: body(humanSeats) });
    expect(res.status).toBe(201);
  });

  it("策略 invite：邀请码正确可创建", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "invite-code-for-test");
    stubCreateOk();
    const res = await post({ body: body(aiSeats, { inviteCode: "invite-code-for-test" }) });
    expect(res.status).toBe(201);
  });

  it("策略 invite：邀请码错误 → 403", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "invite-code-for-test");
    stubCreateOk();
    const res = await post({ body: body(aiSeats, { inviteCode: "wrong-invite-code" }) });
    expect(res.status).toBe(403);
    expect(db.room.create).not.toHaveBeenCalled();
  });

  it("策略 invite：缺邀请码字段 → 403", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "invite-code-for-test");
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(403);
  });

  it("策略 invite：服务端未配置 ROOM_INVITE_CODE 时 fail closed", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "invite");
    vi.stubEnv("ROOM_INVITE_CODE", "");
    stubCreateOk();
    const res = await post({ body: body(aiSeats, { inviteCode: "whatever" }) });
    expect(res.status).toBe(403);
    expect(db.room.create).not.toHaveBeenCalled();
  });

  it("策略 admin：授权检查早于剧本查询，未授权者探不到 404/400 差异", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admin");
    stubCreateOk();
    const res = await post({ body: { scriptId: "ghost-script", seats: aiSeats } });
    expect(res.status).toBe(403);
    expect(db.script.findFirst).not.toHaveBeenCalled();
  });

  it("策略取值无法识别时按生产默认 admin 处理", async () => {
    stubProduction();
    vi.stubEnv("ROOM_CREATE_POLICY", "admim");
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(403);
  });

  it("生产环境漏配 ADMIN_TOKEN：拒绝而不是把配置错误抛成 500", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_MASTER_KEY", "");
    vi.stubEnv("ADMIN_TOKEN", "");
    stubCreateOk();
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("服务未正确配置管理员口令，暂时无法创建含 AI 座位的房间");
  });
});
