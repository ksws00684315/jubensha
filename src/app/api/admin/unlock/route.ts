import { NextResponse } from "next/server";
import { adminCookieHeader, adminPassword, isAdminRequest } from "@/lib/admin";

/** 解锁管理面：本机访问直接发会话 cookie；远程需提交 ADMIN_TOKEN 或 SECRET_MASTER_KEY */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  if (isAdminRequest(req) || (body?.token && adminPassword() && body.token === adminPassword())) {
    const res = NextResponse.json({ ok: true });
    const secure = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || new URL(req.url).protocol === "https:";
    res.headers.append("Set-Cookie", adminCookieHeader(secure));
    return res;
  }
  return NextResponse.json({ error: "口令不正确" }, { status: 401 });
}

export async function GET(req: Request) {
  return NextResponse.json({ admin: isAdminRequest(req) });
}
