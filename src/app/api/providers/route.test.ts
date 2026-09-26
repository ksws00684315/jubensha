import { afterEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

afterEach(() => vi.unstubAllEnvs());

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

/** 加密依赖 SECRET_MASTER_KEY，须在 stubProduction 之后调用。 */
function providerRow() {
  return {
    id: "prov-1",
    name: "本地测试",
    protocol: "openai_compatible",
    baseUrl: "https://api.example.com",
    apiKeyCipher: encryptSecret("sk-secret-abcdef123456"),
    enabled: true,
    note: null,
    createdAt: new Date(),
  };
}

describe("A03 GET /api/providers", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/providers"), ctx({}));
    expect(res.status).toBe(401);
  });

  it("管理员返回列表，apiKey 仅掩码且不含密文字段", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findMany).mockResolvedValue([providerRow()] as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/providers", { headers: adminHeaders() }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].apiKeyMasked).toMatch(/^••••••••[a-z0-9]{4}$/);
    expect(JSON.stringify(body)).not.toContain("apiKeyCipher");
    expect(JSON.stringify(body)).not.toContain("sk-secret-abcdef123456");
  });
});

describe("A04 POST /api/providers", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/providers", { body: { name: "x" } }), ctx({}));
    expect(res.status).toBe(401);
  });

  it("元数据地址 http://169.254.169.254 → 400", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/providers", {
        headers: adminHeaders(),
        body: { name: "bad", protocol: "openai_compatible", baseUrl: "http://169.254.169.254", apiKey: "sk-1" },
      }), ctx({})
    );
    expect(res.status).toBe(400);
    expect(db.aiProvider.create).not.toHaveBeenCalled();
  });

  it("合法创建 → 201，落库的是密文而非明文", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.create).mockResolvedValue({ id: "prov-new" } as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/providers", {
        headers: adminHeaders(),
        body: { name: "p1", protocol: "openai_compatible", baseUrl: "https://api.example.com/v1/", apiKey: "sk-plain-1234567890" },
      }), ctx({})
    );
    expect(res.status).toBe(201);
    const data = vi.mocked(db.aiProvider.create).mock.calls[0][0] as { data: { apiKeyCipher: string; baseUrl: string } };
    expect(data.data.apiKeyCipher).not.toContain("sk-plain-1234567890");
    expect(data.data.apiKeyCipher.split(".")).toHaveLength(3);
    expect(data.data.baseUrl).toBe("https://api.example.com/v1"); // 去尾部斜杠
  });

  it("缺字段 → 400 参数不合法", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/providers", { headers: adminHeaders(), body: { name: "p1" } }), ctx({}));
    expect(res.status).toBe(400);
  });
});
