import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

beforeEach(() => resetRateLimits());

describe("A13 GET /api/usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("非管理员 401", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-test-0123456789");
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/usage"), ctx({}));
    expect(res.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("管理员获得 30 天汇总与最近诊断", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-test-0123456789");
    vi.mocked(db.usageLog.groupBy).mockResolvedValue([
      {
        providerName: "deepseek",
        modelId: "deepseek-chat",
        purpose: "player",
        ok: true,
        _count: { _all: 3 },
        _sum: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedTokens: 0 },
      },
    ] as never);
    vi.mocked(db.usageLog.findMany).mockResolvedValue([] as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/usage", { headers: adminHeaders() }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0]).toMatchObject({ providerName: "deepseek", calls: 3, promptTokens: 10, totalTokens: 30 });
    expect(body.since).toBeTruthy();
    vi.unstubAllEnvs();
  });
});
