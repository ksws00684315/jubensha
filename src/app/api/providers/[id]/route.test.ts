import { afterEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";
import { invalidateBindingCache } from "@/core/llm/client";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/llm/client", () => ({ invalidateBindingCache: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

describe("A05 PATCH /api/providers/[id]", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/providers/p1", { body: { name: "n" } }), ctx({ id: "p1" }));
    expect(res.status).toBe(401);
  });

  it("不存在 → 404", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue(null as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(
      makeReq("PATCH", "/api/providers/p1", { headers: adminHeaders(), body: { name: "n" } }),
      ctx({ id: "p1" })
    );
    expect(res.status).toBe(404);
  });

  it("改 baseUrl 走 SSRF 守卫：元数据地址 → 400", async () => {
    stubProduction();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue({ id: "p1" } as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(
      makeReq("PATCH", "/api/providers/p1", { headers: adminHeaders(), body: { baseUrl: "http://169.254.169.254" } }),
      ctx({ id: "p1" })
    );
    expect(res.status).toBe(400);
    expect(db.aiProvider.update).not.toHaveBeenCalled();
  });

  it("参数不合法 → 400", async () => {
    stubProduction();
    const { PATCH } = await import("./route");
    const res = await PATCH(
      makeReq("PATCH", "/api/providers/p1", { headers: adminHeaders(), body: { enabled: "yes" } }),
      ctx({ id: "p1" })
    );
    expect(res.status).toBe(400);
  });

  it("更新 Provider 成功后使绑定缓存失效", async () => {
    stubProduction();
    vi.mocked(invalidateBindingCache).mockClear();
    vi.mocked(db.aiProvider.findUnique).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(db.aiProvider.update).mockResolvedValue({ id: "p1", apiKeyCipher: "masked" } as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", "/api/providers/p1", { headers: adminHeaders(), body: { enabled: false } }), ctx({ id: "p1" }));
    expect(res.status).toBe(200);
    expect(invalidateBindingCache).toHaveBeenCalledTimes(1);
  });
});

describe("A06 DELETE /api/providers/[id]", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { DELETE } = await import("./route");
    const res = await DELETE(makeReq("DELETE", "/api/providers/p1"), ctx({ id: "p1" }));
    expect(res.status).toBe(401);
  });

  it("管理员删除 → 200 ok", async () => {
    stubProduction();
    vi.mocked(invalidateBindingCache).mockClear();
    vi.mocked(db.aiProvider.delete).mockResolvedValue({ id: "p1" } as never);
    const { DELETE } = await import("./route");
    const res = await DELETE(makeReq("DELETE", "/api/providers/p1", { headers: adminHeaders() }), ctx({ id: "p1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.aiProvider.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(invalidateBindingCache).toHaveBeenCalledTimes(1);
  });

  it("数据库删除失败仍沿用 ok 响应且不使缓存失效", async () => {
    stubProduction();
    vi.mocked(invalidateBindingCache).mockClear();
    vi.mocked(db.aiProvider.delete).mockRejectedValue(new Error("delete failed"));
    const { DELETE } = await import("./route");
    const res = await DELETE(makeReq("DELETE", "/api/providers/p1", { headers: adminHeaders() }), ctx({ id: "p1" }));
    expect(res.status).toBe(200);
    expect(invalidateBindingCache).not.toHaveBeenCalled();
  });
});
