import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesize } from "@/core/tts";
import { db } from "@/lib/db";

const schema = z.object({
  gameId: z.string().min(1),
  eventSeq: z.string().max(19).regex(/^\d+$/),
});

/** 合成语音：返回可播放的音频地址（带缓存去重） */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  try {
    const event = await db.gameEvent.findUnique({ where: { seq: BigInt(parsed.data.eventSeq) } });
    if (!event || event.gameId !== parsed.data.gameId || event.type !== "speech" || event.visibility !== "public") {
      return NextResponse.json({ error: "只能播放公开发言" }, { status: 404 });
    }
    if (event.fromSeat === null) return NextResponse.json({ error: "该事件不是玩家发言" }, { status: 404 });
    const game = await db.game.findUnique({ where: { id: parsed.data.gameId }, include: { room: { include: { seats: true } } } });
    const seat = game?.room.seats.find((s) => s.index === event.fromSeat);
    const content = event.content;
    const text = content && typeof content === "object" && !Array.isArray(content) ? (content as { text?: unknown }).text : null;
    if (!game || seat?.kind !== "ai" || typeof text !== "string" || !text.trim() || text.length > 600) {
      return NextResponse.json({ error: "该事件不可合成语音" }, { status: 404 });
    }
    const result = await synthesize(text);
    return NextResponse.json({ url: `/api/tts/${result.hash}`, cached: result.cached });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
