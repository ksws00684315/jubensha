import { afterEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

afterEach(() => vi.unstubAllEnvs());

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

describe("A08 GET /api/bindings", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/bindings"), ctx({}));
    expect(res.status).toBe(401);
  });

  it("管理员返回槽位列表（含 provider 名与启用状态）", async () => {
    stubProduction();
    vi.mocked(db.modelBinding.findMany).mockResolvedValue([
      {
        slot: "dm",
        providerId: "p1",
        modelId: "m1",
        temperature: null,
        maxTokens: null,
        contextWindow: null,
        supportsSystem: true,
        detectedSystemSupport: true,
        capabilityDetectedAt: new Date("2026-09-26T00:00:00Z"),
        supportsJson: false,
        fallbackSlot: null,
        provider: { name: "测试 Provider", enabled: true },
      },
    ] as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/bindings", { headers: adminHeaders() }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toMatchObject({ slot: "dm", providerName: "测试 Provider", providerEnabled: true, actualMessageMode: "system" });
  });
});

describe("A09 PUT /api/bindings", () => {
  it("slot 不在枚举内 → 400", async () => {
    stubProduction();
    const { PUT } = await import("./route");
    const res = await PUT(
      makeReq("PUT", "/api/bindings", { headers: adminHeaders(), body: { slot: "nope", providerId: "p1", modelId: "m1" } }), ctx({})
    );
    expect(res.status).toBe(400);
  });

  it("providerId 不存在 → 404", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue(null as never);
    const { PUT } = await import("./route");
    const res = await PUT(
      makeReq("PUT", "/api/bindings", { headers: adminHeaders(), body: { slot: "dm", providerId: "ghost", modelId: "m1" } }), ctx({})
    );
    expect(res.status).toBe(404);
  });

  it("provider 已禁用 → 400", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue({ id: "p1", enabled: false } as never);
    const { PUT } = await import("./route");
    const res = await PUT(
      makeReq("PUT", "/api/bindings", { headers: adminHeaders(), body: { slot: "dm", providerId: "p1", modelId: "m1" } }), ctx({})
    );
    expect(res.status).toBe(400);
    expect(db.modelBinding.upsert).not.toHaveBeenCalled();
  });

  it("合法 upsert → 200 且写库数据正确", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue({ id: "p1", enabled: true } as never);
    vi.mocked(db.modelBinding.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.modelBinding.upsert).mockResolvedValue({ slot: "player" } as never);
    const { PUT } = await import("./route");
    const res = await PUT(
      makeReq("PUT", "/api/bindings", { headers: adminHeaders(), body: { slot: "player", providerId: "p1", modelId: "m1" } }), ctx({})
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: "player" });
  });
});
