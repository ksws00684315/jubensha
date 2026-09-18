import { NextResponse } from "next/server";

/**
 * 路由统一异常兜底：任何未捕获错误都转成 500 JSON，且只回显固定文案——
 * 内部错误细节（Prisma 报错、上游报文）只进服务端日志，不进响应体（独立审查 M4）。
 * 各路由自己已 return 的 4xx 语义不受影响。
 */
export function withRoute<P>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>
): (req: Request, ctx: { params: Promise<P> }) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      let path = req.url;
      try {
        path = new URL(req.url).pathname;
      } catch {
        /* 保留原始 url */
      }
      console.error(`[api] ${req.method} ${path} 未捕获异常：${detail}`);
      return NextResponse.json({ error: "服务器内部错误，请稍后重试" }, { status: 500 });
    }
  };
}
