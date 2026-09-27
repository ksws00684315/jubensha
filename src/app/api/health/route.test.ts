import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, makeReq, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { engines } from "@/core/engine/registry";
import { heldLeaseCount } from "@/core/engine/lease";

const queryRaw = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: { $queryRaw: queryRaw } }));
vi.mock("@/core/engine/registry", () => ({ engines: new Map() }));
vi.mock("@/core/engine/lease", () => ({ heldLeaseCount: vi.fn() }));
vi.mock("@/core/llm/budget", () => ({ dailyTokenBudget: vi.fn(() => 500), usedTokensToday: vi.fn(async () => 120) }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  engines.clear();
  vi.mocked(db.$queryRaw).mockResolvedValue([{ "?column?": 1 }] as never);
  vi.mocked(heldLeaseCount).mockReturnValue(2);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", "admin-token-for-test-0123456789");
  vi.stubEnv("ADMIN_TRUST_LOOPBACK", "0");
});

describe("A36 GET /api/health", () => {
  it("匿名响应严格只有存活、数据库和 uptime 三个字段", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/health"), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "up", uptimeSec: expect.any(Number) });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(heldLeaseCount).not.toHaveBeenCalled();
  });

  it("管理员额外获得引擎、租约、最长空闲秒数与预算", async () => {
    const now = Date.now();
    engines.set("g-health", {
      events: [{ createdAt: new Date(now - 12_000).toISOString() }],
    } as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/health", { headers: adminHeaders() }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      db: "up",
      uptimeSec: expect.any(Number),
      engines: 1,
      leasesHeld: 2,
      oldestStuckPhaseSec: expect.any(Number),
      budget: { used: 120, limit: 500 },
    });
    expect(body.oldestStuckPhaseSec).toBeGreaterThanOrEqual(12);
  });

  it("数据库不可用或 1 秒超时时返回 503，且不返回管理员字段", async () => {
    vi.mocked(db.$queryRaw).mockRejectedValueOnce(new Error("database unavailable"));
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/health", { headers: adminHeaders() }), { params: Promise.resolve({}) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "down", uptimeSec: expect.any(Number) });
    expect(heldLeaseCount).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      vi.mocked(db.$queryRaw).mockImplementationOnce(() => new Promise(() => {}) as never);
      const timeoutResponse = GET(makeReq("GET", "/api/health"), { params: Promise.resolve({}) });
      await vi.advanceTimersByTimeAsync(1_000);
      const timeoutResult = await timeoutResponse;
      expect(timeoutResult.status).toBe(503);
      expect(await timeoutResult.json()).toEqual({ ok: false, db: "down", uptimeSec: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });
});
