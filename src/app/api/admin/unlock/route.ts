import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { adminCookieHeader, adminPassword, isAdminRequest, safeEqualString } from "@/lib/admin";
import { clientIp, rateLimit } from "@/lib/rate-limit";

/** 解锁管理面：本机访问直接发会话 cookie；远程需提交 ADMIN_TOKEN 或 SECRET_MASTER_KEY */
async function POST_IMPL(req: Request) {
  const ip = clientIp(req);
  const limited = rateLimit(`admin:unlock:ip:${ip}`, 5, 60_000);
  const global = rateLimit("admin:unlock:global", 60, 60_000);
  if (!limited.ok || !global.ok) {
    const retryAfter = Math.ceil(Math.max(limited.retryAfterMs, global.retryAfterMs) / 1000);
    return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  const password = adminPassword();
  if (isAdminRequest(req) || (body?.token && password && safeEqualString(body.token, password))) {
    const res = NextResponse.json({ ok: true });
    const secure = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || new URL(req.url).protocol === "https:";
    res.headers.append("Set-Cookie", adminCookieHeader(secure));
    return res;
  }
  return NextResponse.json({ error: "口令不正确" }, { status: 401 });
}

async function GET_IMPL(req: Request) {
  return NextResponse.json({ admin: isAdminRequest(req) });
}

export const POST = withRoute(POST_IMPL);
export const GET = withRoute(GET_IMPL);
