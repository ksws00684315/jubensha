import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { assertPostgresUrl, maskDatabaseUrl, resolveDatabaseUrl, writeAppConfig } from "@/lib/app-config";
import { pingDatabase, reconnectDatabase } from "@/lib/db";

const bodySchema = z.object({
  url: z.string().min(1),
});

async function GET_IMPL(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const resolved = resolveDatabaseUrl();
  if (!resolved.url) {
    return NextResponse.json({ configured: false, source: "none", urlMasked: null, ok: false });
  }
  const ping = await pingDatabase(resolved.url);
  return NextResponse.json({
    configured: true,
    source: resolved.source,
    urlMasked: maskDatabaseUrl(resolved.url),
    ok: ping.ok,
    hasSchema: ping.ok ? ping.hasSchema : false,
    error: ping.ok ? undefined : ping.error,
  });
}

/** 测试连通性，不落盘 */
async function POST_IMPL(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请填写数据库地址" }, { status: 400 });
  let url: string;
  try {
    url = assertPostgresUrl(parsed.data.url);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const ping = await pingDatabase(url);
  if (!ping.ok) return NextResponse.json({ ok: false, error: ping.error }, { status: 502 });
  return NextResponse.json({ ok: true, hasSchema: ping.hasSchema });
}

/** 保存到 local.app.json 并切换当前连接 */
async function PUT_IMPL(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请填写数据库地址" }, { status: 400 });
  let url: string;
  try {
    url = assertPostgresUrl(parsed.data.url);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const ping = await pingDatabase(url);
  if (!ping.ok) return NextResponse.json({ error: `连不上该数据库：${ping.error}` }, { status: 502 });
  writeAppConfig({ databaseUrl: url });
  try {
    await reconnectDatabase(url);
  } catch (err) {
    // Prisma 连接错误细节只进日志；响应给固定文案（admin 可看日志排查）
    console.error("[settings/database] 切换连接失败：", err);
    return NextResponse.json({ error: "数据库连接切换失败，请检查地址与网络后重试" }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    hasSchema: ping.hasSchema,
    source: "file",
    urlMasked: maskDatabaseUrl(url),
  });
}

export const GET = withRoute(GET_IMPL);
export const POST = withRoute(POST_IMPL);
export const PUT = withRoute(PUT_IMPL);
