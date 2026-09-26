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

const ID = "script-1";

describe("A16 GET /api/scripts/[id]", () => {
  it("不存在 → 404", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(null as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/scripts/${ID}`), ctx({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("公开视图不含 truth / 私卡字段", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/scripts/${ID}`), ctx({ id: ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.public).toBeTruthy();
    const raw = JSON.stringify(body.public);
    expect(raw).not.toContain("truth");
    expect(raw).not.toContain("privateCard");
    expect(body.admin).toBe(false);
  });

  it("full=1 非管理员 401", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/scripts/${ID}?full=1`), ctx({ id: ID }));
    expect(res.status).toBe(401);
  });

  it("full=1 管理员拿到完整文档与设计包", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow({ designPackage: { author: "a" }, designHash: "h1" }) as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/scripts/${ID}?full=1`, { headers: adminHeaders() }), ctx({ id: ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc).toBeTruthy();
    expect(body.designHash).toBe("h1");
  });
});

describe("A17 PATCH /api/scripts/[id]", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", `/api/scripts/${ID}`, { body: { doc: { version: 2 } } }), ctx({ id: ID }));
    expect(res.status).toBe(401);
  });

  it("不存在 → 404", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(null as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(makeReq("PATCH", `/api/scripts/${ID}`, { headers: adminHeaders(), body: { doc: { version: 2 } } }), ctx({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("非法文档 → 400", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { PATCH } = await import("./route");
    const res = await PATCH(
      makeReq("PATCH", `/api/scripts/${ID}`, { headers: adminHeaders(), body: { doc: { version: 2, meta: { title: "坏" } } } }),
      ctx({ id: ID })
    );
    expect(res.status).toBe(400);
  });
});

describe("A18 DELETE /api/scripts/[id]", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { DELETE } = await import("./route");
    const res = await DELETE(makeReq("DELETE", `/api/scripts/${ID}`), ctx({ id: ID }));
    expect(res.status).toBe(401);
  });

  it("软删除：update({deleted:true}) 而非物理 delete", async () => {
    stubProduction();
    vi.mocked(db.script.update).mockResolvedValue({ id: ID } as never);
    const { DELETE } = await import("./route");
    const res = await DELETE(makeReq("DELETE", `/api/scripts/${ID}`, { headers: adminHeaders() }), ctx({ id: ID }));
    expect(res.status).toBe(200);
    expect(db.script.update).toHaveBeenCalledWith({ where: { id: ID }, data: { deleted: true } });
    expect(db.script.delete).not.toHaveBeenCalled();
  });
});

describe("A19 POST /api/scripts/[id]（导出）", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/scripts/${ID}`), ctx({ id: ID }));
    expect(res.status).toBe(401);
  });

  it("不存在 → 404", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/scripts/${ID}`, { headers: adminHeaders() }), ctx({ id: ID }));
    expect(res.status).toBe(404);
  });

  it("管理员导出 → JSON 附件下载", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", `/api/scripts/${ID}`, { headers: adminHeaders() }), ctx({ id: ID }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.json();
    expect(body.meta.title).toBeTruthy();
  });
});
