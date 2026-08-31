import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

/** 提供缓存的 TTS 音频文件 */
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  if (!/^[a-f0-9]{32}$/.test(hash)) return NextResponse.json({ error: "hash 不合法" }, { status: 400 });
  const cached = await db.ttsCache.findUnique({ where: { hash } });
  if (!cached) return NextResponse.json({ error: "音频不存在" }, { status: 404 });
  try {
    const stream = Readable.toWeb(createReadStream(cached.filePath)) as ReadableStream;
    return new NextResponse(stream, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch {
    return NextResponse.json({ error: "音频文件丢失" }, { status: 404 });
  }
}
