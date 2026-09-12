import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";

export const ADMIN_COOKIE = "jbs_admin";

function masterSecret(): string {
  return process.env.ADMIN_TOKEN || process.env.SECRET_MASTER_KEY || "";
}

/**
 * 会话签名密钥。默认回落到 SECRET_MASTER_KEY 以兼容既有部署，
 * 但**推荐**用独立的 ADMIN_SESSION_SECRET：主密钥同时负责 provider apiKey 的 AES-GCM 加密，
 * 一钥两用会把"加密密钥泄露"直接升级成"可离线伪造管理会话"（见独立审查 M5）。
 */
function sessionSigningSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || process.env.SECRET_MASTER_KEY || masterSecret();
}

/** 写入浏览器的会话值，不是明文口令。绑定 ADMIN_TOKEN：轮换口令即失效所有旧会话。 */
export function adminSessionToken(): string {
  const secret = sessionSigningSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(`jbs-admin-session:${process.env.ADMIN_TOKEN ?? ""}`).digest("hex");
}

export function adminPassword(): string {
  return masterSecret();
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.split(":")[0].toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1";
}

/** 该开关一旦误开，生产构建下等价于信任所有能访问该端口的主机；启动期只提醒一次。 */
let trustLoopbackWarned = false;

function warnTrustLoopbackOnce(): void {
  if (trustLoopbackWarned) return;
  trustLoopbackWarned = true;
  console.warn(
    "[admin] ADMIN_TRUST_LOOPBACK 已开启：生产构建下 Host 头由客户端控制，" +
      "「信任本机」实际等价于信任所有能访问该端口的主机。请确保进程只监听 127.0.0.1（HOSTNAME=127.0.0.1）并经反代对外。"
  );
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
  // 本机免登录默认只在开发环境生效。生产构建(next start)里 Host 可被客户端伪造,
  // 因此需要显式设置 ADMIN_TRUST_LOOPBACK=1 才开启——仅适用于服务只在本机/可信网络使用的部署。
  const trustLoopback =
    process.env.ADMIN_TRUST_LOOPBACK === "1" || process.env.ADMIN_TRUST_LOOPBACK === "true";
  if (trustLoopback) warnTrustLoopbackOnce();
  if (process.env.NODE_ENV === "production" && !trustLoopback) return false;
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

export function adminCookieHeader(secure = false): string {
  const parts = [
    `${ADMIN_COOKIE}=${adminSessionToken()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
