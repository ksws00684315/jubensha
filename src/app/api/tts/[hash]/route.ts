import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { once } from "node:events";

/** 提供缓存的 TTS 音频文件 */
async function GET_IMPL(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(hash)) return NextResponse.json({ error: "hash 不合法" }, { status: 400 });
  const cached = await db.ttsCache.findUnique({ where: { hash } });
  if (!cached) return NextResponse.json({ error: "音频不存在" }, { status: 404 });
  const file = createReadStream(cached.filePath);
  try {
    // createReadStream 的文件打开错误异步触发；先等 open，才能在响应头发送前返回 404。
    await once(file, "open");
    const stream = Readable.toWeb(file) as ReadableStream;
    return new NextResponse(stream, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch {
    file.destroy();
    return NextResponse.json({ error: "音频文件丢失" }, { status: 404 });
  }
}

export const GET = withRoute(GET_IMPL);
