import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";

export const ADMIN_COOKIE = "jbs_admin";

function masterSecret(): string {
  return process.env.ADMIN_TOKEN || process.env.SECRET_MASTER_KEY || "";
}

/** 写入浏览器的会话值，不是明文口令 */
export function adminSessionToken(): string {
  const secret = process.env.SECRET_MASTER_KEY || masterSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update("jbs-admin-session").digest("hex");
}

export function adminPassword(): string {
  return masterSecret();
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.split(":")[0].toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

export function isAdminSync(opts: {
  cookie?: string | null;
  host?: string | null;
  xff?: string | null;
  tokenHeader?: string | null;
}): boolean {
  const session = adminSessionToken();
  if (session && opts.cookie === session) return true;
  const password = adminPassword();
  if (password && opts.tokenHeader && opts.tokenHeader === password) return true;
  // 本机直接访问视为管理员。必须 Host 也是回环，避免伪造 X-Forwarded-For。
  const xff = opts.xff?.split(",")[0]?.trim() ?? "";
  const xffLoopback =
    !xff || xff === "127.0.0.1" || xff === "::1" || xff === "::ffff:127.0.0.1" || isLoopbackHost(xff);
  if (isLoopbackHost(opts.host ?? null) && xffLoopback) return true;
  return false;
}

export function isAdminRequest(req: Request): boolean {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${ADMIN_COOKIE}=`));
  const cookie = match ? decodeURIComponent(match.slice(ADMIN_COOKIE.length + 1)) : null;
  let host: string | null = req.headers.get("host");
  try {
    host = host || new URL(req.url).host;
  } catch {
    /* ignore */
  }
  return isAdminSync({
    cookie,
    host,
    xff: req.headers.get("x-forwarded-for"),
    tokenHeader: req.headers.get("x-admin-token"),
  });
}

export async function isAdminServer(): Promise<boolean> {
  const h = await headers();
  const c = await cookies();
  return isAdminSync({
    cookie: c.get(ADMIN_COOKIE)?.value ?? null,
    host: h.get("host"),
    xff: h.get("x-forwarded-for"),
    tokenHeader: h.get("x-admin-token"),
  });
}

export function requireAdmin(req: Request): NextResponse | null {
  if (isAdminRequest(req)) return null;
  return NextResponse.json({ error: "需要管理员身份" }, { status: 401 });
}

export function adminCookieHeader(): string {
  const parts = [
    `${ADMIN_COOKIE}=${adminSessionToken()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  return parts.join("; ");
}
