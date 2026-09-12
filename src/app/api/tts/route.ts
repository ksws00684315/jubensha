import { NextResponse } from "next/server";
import { z } from "zod";
import { synthesize } from "@/core/tts";
import { db } from "@/lib/db";

const schema = z.object({
  gameId: z.string().min(1),
  eventSeq: z.string().max(19).regex(/^\d+$/),
  /** 鉴权：玩家给 seat + token；真人主持给 dm=true + dmToken。 */
  seat: z.number().int().min(0).optional(),
  token: z.string().optional(),
  dm: z.boolean().optional(),
  dmToken: z.string().optional(),
});

/**
 * 合成语音：返回可播放的音频地址（带缓存去重）。
 * 需要本局玩家或真人主持凭证——房间码本身不是凭证，
 * 否则任何人凭 5 位房间码拿到 gameId 就能反复触发合成、白刷 TTS 额度。
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  const { gameId, eventSeq, seat, token, dm, dmToken } = parsed.data;
  try {
    const game = await db.game.findUnique({ where: { id: gameId }, include: { room: { include: { seats: true } } } });
    if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });
    const room = game.room;
    const seatOk = seat !== undefined && !!token && room.seats.some((s) => s.index === seat && !!s.token && s.token === token);
    const dmOk = dm === true && room.humanDm && !!room.dmToken && room.dmToken === dmToken;
    if (!seatOk && !dmOk) {
      return NextResponse.json({ error: "需要本局玩家或主持人身份才能合成语音" }, { status: 401 });
    }

    const event = await db.gameEvent.findUnique({ where: { seq: BigInt(eventSeq) } });
    if (!event || event.gameId !== gameId || event.type !== "speech" || event.visibility !== "public") {
      return NextResponse.json({ error: "只能播放公开发言" }, { status: 404 });
    }
    if (event.fromSeat === null) return NextResponse.json({ error: "该事件不是玩家发言" }, { status: 404 });
    const speaker = room.seats.find((s) => s.index === event.fromSeat);
    const content = event.content;
    const text = content && typeof content === "object" && !Array.isArray(content) ? (content as { text?: unknown }).text : null;
    if (speaker?.kind !== "ai" || typeof text !== "string" || !text.trim() || text.length > 600) {
      return NextResponse.json({ error: "该事件不可合成语音" }, { status: 404 });
    }
    const result = await synthesize(text);
    return NextResponse.json({ url: `/api/tts/${result.hash}`, cached: result.cached });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
