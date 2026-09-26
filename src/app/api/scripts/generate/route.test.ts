import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, resetRateLimits, TEST_ADMIN_TOKEN } from "@/test/api";
import { chat } from "@/core/llm/client";

vi.mock("@/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm/client")>();
  return { ...actual, chat: vi.fn() };
});

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

describe("A21 POST /api/scripts/generate", () => {
  it("非管理员 401", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts/generate", { body: { stage: 1 } }), ctx({}));
    expect(res.status).toBe(401);
  });

  it("参数不合法 → 400", async () => {
    stubProduction();
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts/generate", { headers: adminHeaders(), body: { stage: 3 } }), ctx({}));
    expect(res.status).toBe(400);
    expect(chat).not.toHaveBeenCalled();
  });

  it("stage=1：LLM 返回骨架 JSON（mock，不触网）", async () => {
    stubProduction();
    vi.mocked(chat).mockResolvedValue({ text: '{"title":"测试骨架"}' } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts/generate", { headers: adminHeaders(), body: { stage: 1, theme: "民国" } }), ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outline: { title: "测试骨架" } });
  });

  it("模型输出非法 JSON → 502", async () => {
    stubProduction();
    vi.mocked(chat).mockResolvedValue({ text: "不是 JSON" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts/generate", { headers: adminHeaders(), body: { stage: 1 } }), ctx({}));
    expect(res.status).toBe(502);
  });

  it("chat 抛错 → 502", async () => {
    stubProduction();
    vi.mocked(chat).mockRejectedValue(new Error("LLM down") as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/scripts/generate", { headers: adminHeaders(), body: { stage: 1 } }), ctx({}));
    expect(res.status).toBe(502);
  });
});
