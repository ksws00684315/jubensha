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
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "");
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
    vi.mocked(db.usageLog.aggregate).mockResolvedValue({ _sum: { totalTokens: 123 } } as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/usage", { headers: adminHeaders() }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toHaveLength(1);
    expect(body.summary[0]).toMatchObject({ providerName: "deepseek", calls: 3, promptTokens: 10, totalTokens: 30 });
    expect(body.since).toBeTruthy();
    // S3.2：熔断关闭时看板要如实显示「未设上限」，而不是省略字段让页面猜
    expect(body.budget).toMatchObject({ daily: 0, usedToday: 123 });
    expect(Date.parse(body.budget.dayStart)).not.toBeNaN();
    vi.unstubAllEnvs();
  });

  it("S3.2 配置了每日预算时返回上限与当日合计（当日按本地时区求和）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-test-0123456789");
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "2000000");
    vi.mocked(db.usageLog.groupBy).mockResolvedValue([] as never);
    vi.mocked(db.usageLog.findMany).mockResolvedValue([] as never);
    vi.mocked(db.usageLog.aggregate).mockResolvedValue({ _sum: { totalTokens: 1_450_000 } } as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/usage", { headers: adminHeaders() }), ctx({}));
    const body = await res.json();
    expect(body.budget).toEqual({ daily: 2_000_000, usedToday: 1_450_000, dayStart: expect.any(String) });
    const dayStart = new Date(body.budget.dayStart);
    const now = new Date();
    expect(dayStart.getFullYear()).toBe(now.getFullYear());
    expect(dayStart.getMonth()).toBe(now.getMonth());
    expect(dayStart.getDate()).toBe(now.getDate());
    expect(dayStart.getHours()).toBe(0);
    // 看板每次都要读实时值，不能复用熔断器那份 60s 缓存（否则占比会滞后一分钟）
    expect(db.usageLog.aggregate).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
