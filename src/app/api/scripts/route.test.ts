import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
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

const exampleDoc = () => JSON.parse(readFileSync(path.join(process.cwd(), "seeds/examples/script-v2.example.json"), "utf8"));
const v1Doc = () => JSON.parse(readFileSync(path.join(process.cwd(), "seeds/fixtures/script-v1.sample.json"), "utf8"));

describe("A14 GET /api/scripts", () => {
  it("返回元数据列表，不含正文/真相/设计包", async () => {
    const { ...meta } = scriptRow();
    delete (meta as Record<string, unknown>).content;
    delete (meta as Record<string, unknown>).designPackage;
    vi.mocked(db.script.findMany).mockResolvedValue([meta] as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/scripts"), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("designPackage");
    // select 只取元数据列，正文不会出现在响应里
    expect(body[0].content).toBeUndefined();
    expect(body[0].title).toBeTruthy();
  });

  it("只列出未删除的剧本", async () => {
    vi.mocked(db.script.findMany).mockResolvedValue([] as never);
    const { GET } = await import("./route");
    await GET(makeReq("GET", "/api/scripts"), ctx({}));
    expect(db.script.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deleted: false } }));
  });
});

describe("A15 POST /api/scripts", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts", { body: { doc: exampleDoc() } }), ctx({}));
    expect(res.status).toBe(401);
  });

  it("V1 文档自动迁移为 V2 入库", async () => {
    stubProduction();
    vi.mocked(db.script.create).mockResolvedValue({ id: "s-new" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts", { headers: adminHeaders(), body: { doc: v1Doc() } }), ctx({}));
    expect(res.status).toBe(201);
    const arg = vi.mocked(db.script.create).mock.calls[0][0] as unknown as { data: { content: { version: number } } };
    expect(arg.data.content.version).toBe(2);
  });

  it("非法 JSON → 400", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const req = new Request("http://localhost/api/scripts", { method: "POST", headers: adminHeaders(), body: "{not-json" });
    const res = await POST(req, ctx({}));
    expect(res.status).toBe(400);
  });

  it("结构非法的文档 → 400 带问题清单", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts", { headers: adminHeaders(), body: { doc: { version: 2 } } }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("合法 V2 文档 → 201", async () => {
    stubProduction();
    vi.mocked(db.script.create).mockResolvedValue({ id: "s-new" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts", { headers: adminHeaders(), body: { doc: exampleDoc() } }), ctx({}));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "s-new" });
  });
});
