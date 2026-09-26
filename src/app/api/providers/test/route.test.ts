import { afterEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";
import { testProviderConnection } from "@/core/llm/client";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/llm/client", () => ({ testProviderConnection: vi.fn(async () => ({ ok: true, model: "m1" })) }));

afterEach(() => vi.unstubAllEnvs());

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

describe("A07 POST /api/providers/test", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/providers/test", { body: { providerId: "p1" } }), ctx({}));
    expect(res.status).toBe(401);
  });

  it("元数据地址 → 400，不发真实网络请求", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/providers/test", {
        headers: adminHeaders(),
        body: { protocol: "openai_compatible", baseUrl: "http://169.254.169.254", apiKey: "sk-1" },
      }), ctx({})
    );
    expect(res.status).toBe(400);
    expect(testProviderConnection).not.toHaveBeenCalled();
  });

  it("providerId 不存在 → 404", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/providers/test", { headers: adminHeaders(), body: { providerId: "missing" } }), ctx({})
    );
    expect(res.status).toBe(404);
  });

  it("新配置合法 → 200，LLM 客户端被 mock（不触网）", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/providers/test", {
        headers: adminHeaders(),
        body: { protocol: "openai_compatible", baseUrl: "https://api.example.com", apiKey: "sk-1" },
      }), ctx({})
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("同时传 providerId 与完整配置 → 400", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/providers/test", {
        headers: adminHeaders(),
        body: { providerId: "p1", protocol: "openai_compatible", baseUrl: "https://api.example.com", apiKey: "sk-1" },
      }), ctx({})
    );
    expect(res.status).toBe(400);
  });
});
