import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { log } from "@/lib/log";

/**
 * 路由统一异常兜底：任何未捕获错误都转成 500 JSON，且只回显固定文案——
 * 内部错误细节（Prisma 报错、上游报文）只进服务端日志，不进响应体（独立审查 M4）。
 * 各路由自己已 return 的 4xx 语义不受影响。
 */
export function withRoute<P>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>
): (req: Request, ctx: { params: Promise<P> }) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = randomUUID();
    try {
      return await handler(req, ctx);
    } catch (err) {
      let path = req.url;
      try {
        path = new URL(req.url).pathname;
      } catch {
        /* 保留原始 url */
      }
      log.error(`${req.method} ${path} api.unhandled`, { method: req.method, path, requestId, error: err });
      // 固定文案不外泄错误细节（独立审查 M4）；带下一步动作建议与 requestId 供反馈定位（T3.2，
      // 2026-10-01 实测：故障期间玩家连续收到零指引文案，无法区分"重试/重进/联系房主"）。
      return NextResponse.json(
        { error: "服务暂时不可用，请稍后重试；若持续出现，请刷新页面或联系房主。", requestId },
        { status: 500 },
      );
    }
  };
}
