import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesize } from "@/core/tts";

const schema = z.object({ text: z.string().min(1).max(600) });

/** 合成语音：返回可播放的音频地址（带缓存去重） */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  try {
    const result = await synthesize(parsed.data.text);
    return NextResponse.json({ url: `/api/tts/${result.hash}`, cached: result.cached });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
