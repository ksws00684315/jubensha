import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, resetRateLimits, TEST_ADMIN_TOKEN } from "@/test/api";
import { adminSessionToken } from "@/lib/admin";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimits();
});

/** 生产模式分支需要完整的管理配置（assertAdminConfig 的要求）。 */
function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

describe("A01 POST /api/admin/unlock", () => {
  beforeEach(() => resetRateLimits());

  it("正确口令 → 200 + Set-Cookie（HttpOnly、SameSite=Lax）", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/admin/unlock", { body: { token: TEST_ADMIN_TOKEN } }), ctx({}));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("jbs_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("错口令 → 401 且无 Set-Cookie", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/admin/unlock", { body: { token: "wrong-token" } }), ctx({}));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("生产环境未配 ADMIN_TOKEN → 500 固定文案", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/admin/unlock", { body: { token: "anything" } }), ctx({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "服务器内部错误，请稍后重试" });
  });

  it("限流：同 IP 第 6 次/分钟 → 429 且带 Retry-After", async () => {
    stubProduction();
    const { POST } = await import("./route");
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await POST(makeReq("POST", "/api/admin/unlock", { body: { token: "wrong" }, headers: { "x-forwarded-for": "10.1.1.9" } }), ctx({}));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("A02 GET /api/admin/unlock", () => {
  it("带合法会话 cookie → {admin:true}", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/admin/unlock", { headers: { cookie: `jbs_admin=${adminSessionToken()}` } }), ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admin: true });
  });

  it("无凭证 → {admin:false}", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/admin/unlock"), ctx({}));
    expect(await res.json()).toEqual({ admin: false });
  });

  it("生产环境 Host: localhost 且未开 ADMIN_TRUST_LOOPBACK → false", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(
      makeReq("GET", "/api/admin/unlock", { headers: { host: "localhost", "x-forwarded-for": "127.0.0.1" } }), ctx({})
    );
    expect(await res.json()).toEqual({ admin: false });
  });
});

describe("A01/A02 夹具回归", () => {
  it("adminHeaders 与 stubProduction 的口令一致（防测试间漂移）", () => {
    stubProduction();
    expect(adminHeaders()["x-admin-token"]).toBe(TEST_ADMIN_TOKEN);
  });
});
