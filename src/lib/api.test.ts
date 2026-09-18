import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { withRoute } from "./api";

const ctx = { params: Promise.resolve({ id: "game-1" }) };

describe("withRoute 统一异常兜底", () => {
  afterEach(() => vi.restoreAllMocks());

  it("handler 正常返回时原样透传（4xx 语义不受影响）", async () => {
    const handler = vi.fn(async () => NextResponse.json({ error: "参数不合法" }, { status: 400 }));
    const res = await withRoute(handler)(new Request("http://x/api/games/game-1/actions", { method: "POST" }), ctx);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "参数不合法" });
  });

  it("未捕获异常转 500，响应体只回固定文案、不回显内部错误细节", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = vi.fn(async () => {
      throw new Error("PrismaClientKnownRequestError: P2002 unique constraint failed on (gameId,seq)");
    });
    const res = await withRoute(handler)(new Request("http://x/api/games/game-1/actions", { method: "POST" }), ctx);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("服务器内部错误，请稍后重试");
    expect(JSON.stringify(body)).not.toContain("P2002");
    expect(JSON.stringify(body)).not.toContain("Prisma");
    // 细节只进服务端日志，且带方法/路径定位信息
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("POST /api/games/game-1/actions");
  });

  it("非 Error 抛出物也安全序列化", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = vi.fn(async () => {
      throw "string failure";
    });
    const res = await withRoute(handler)(new Request("http://x/api/usage", { method: "GET" }), ctx);
    expect(res.status).toBe(500);
  });
});
