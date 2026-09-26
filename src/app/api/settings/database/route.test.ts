import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, TEST_ADMIN_TOKEN } from "@/test/api";
import { writeAppConfig } from "@/lib/app-config";
import { pingDatabase, reconnectDatabase } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  pingDatabase: vi.fn(async () => ({ ok: true, hasSchema: true })),
  reconnectDatabase: vi.fn(async () => undefined),
}));
vi.mock("@/lib/app-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-config")>();
  return { ...actual, writeAppConfig: vi.fn() };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(writeAppConfig).mockReset();
});

beforeEach(() => vi.clearAllMocks());

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
  // 防止读到真实 local.app.json：指向必然不存在的文件，回落到 DATABASE_URL
  vi.stubEnv("APP_CONFIG_PATH", "/nonexistent/app-config-for-test.json");
  vi.stubEnv("DATABASE_URL", "postgresql://alice:s3cret@db.example.com:5432/jubensha");
}

describe("A10 GET /api/settings/database", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/settings/database"), ctx({}));
    expect(res.status).toBe(401);
  });

  it("管理员拿到掩码连接串，密码为 ****", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/settings/database", { headers: adminHeaders() }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ configured: true, source: "env", ok: true, hasSchema: true });
    expect(body.urlMasked).toContain("****");
    expect(body.urlMasked).not.toContain("s3cret");
  });
});

describe("A11 POST /api/settings/database", () => {
  it("非 postgresql:// → 400", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/settings/database", { headers: adminHeaders(), body: { url: "mysql://x/y" } }), ctx({}));
    expect(res.status).toBe(400);
    expect(pingDatabase).not.toHaveBeenCalled();
  });

  it("ping 失败 → 502 且带错误", async () => {
    stubProduction();
    vi.mocked(pingDatabase).mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" } as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/settings/database", { headers: adminHeaders(), body: { url: "postgresql://down@localhost:5/db" } }), ctx({})
    );
    expect(res.status).toBe(502);
  });

  it("ping 成功 → 200 ok", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/settings/database", { headers: adminHeaders(), body: { url: "postgresql://u:p@localhost:5432/jbs" } }), ctx({})
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hasSchema: true });
  });
});

describe("A12 PUT /api/settings/database", () => {
  it("管理员写配置：writeAppConfig 收到测试过的地址，随后重连", async () => {
    stubProduction();
    const { PUT } = await import("./route");
    const res = await PUT(
      makeReq("PUT", "/api/settings/database", { headers: adminHeaders(), body: { url: "postgresql://u:p@localhost:5432/jbs" } }), ctx({})
    );
    expect(res.status).toBe(200);
    expect(writeAppConfig).toHaveBeenCalledWith({ databaseUrl: "postgresql://u:p@localhost:5432/jbs" });
    expect(reconnectDatabase).toHaveBeenCalledWith("postgresql://u:p@localhost:5432/jbs");
  });

  it("ping 失败则不落盘 → 502", async () => {
    stubProduction();
    vi.mocked(pingDatabase).mockResolvedValueOnce({ ok: false, error: "timeout" } as never);
    const { PUT } = await import("./route");
    const res = await PUT(
      makeReq("PUT", "/api/settings/database", { headers: adminHeaders(), body: { url: "postgresql://u:p@localhost:5432/jbs" } }), ctx({})
    );
    expect(res.status).toBe(502);
    expect(writeAppConfig).not.toHaveBeenCalled();
  });
});
