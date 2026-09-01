import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import crypto from "node:crypto";
import { decideJoin } from "@/lib/join";

const joinSchema = z.object({
  code: z.string().min(3),
  name: z.string().min(1).max(20),
  token: z.string().min(1).optional(),
  hostToken: z.string().min(1).optional(),
});

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

/** 大厅入座；恢复已有座位必须提供旧 token，或由房主 token 明确确认。 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const name = parsed.data.name.trim();
  const room = await db.room.findUnique({
    where: { code: parsed.data.code.toUpperCase() },
    include: { seats: { orderBy: { index: "asc" } }, game: true },
  });
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });

  const decision = decideJoin(room.status, room.seats, name, parsed.data.token, parsed.data.hostToken, room.hostToken);
  if (decision.type === "ambiguous") {
    return NextResponse.json({ error: "该昵称对应多个座位，请换一个更独特的名字" }, { status: 400 });
  }
  if (decision.type === "resume") {
    const token = newToken();
    await db.seat.update({ where: { id: decision.seat.id }, data: { token } });
    return NextResponse.json({
      roomId: room.id,
      seatIndex: decision.seat.index,
      token,
      characterId: decision.seat.characterId,
      gameId: room.game?.id ?? null,
      resumed: true,
    });
  }
  if (decision.type === "started") {
    return NextResponse.json({ error: "对局已开始。恢复座位需要原设备凭证，或请房主确认。" }, { status: 403 });
  }
  if (decision.type === "taken") {
    return NextResponse.json({ error: "该昵称已被占用，恢复座位需要原设备凭证，或请房主确认。" }, { status: 403 });
  }
  if (decision.type === "full") {
    return NextResponse.json({ error: "房间已满（没有空的真人座位）" }, { status: 400 });
  }

  const token = newToken();
  for (const openSeat of decision.open) {
    const claimed = await db.seat.updateMany({
      where: { id: openSeat.id, token: null, kind: "human" },
      data: { playerName: name, token },
    });
    if (claimed.count !== 1) continue;
    const seat = await db.seat.findUnique({ where: { id: openSeat.id } });
    if (!seat) continue;
    return NextResponse.json({
      roomId: room.id,
      seatIndex: seat.index,
      token,
      characterId: seat.characterId,
      gameId: null,
      resumed: false,
    });
  }
  return NextResponse.json({ error: "房间已满（没有空的真人座位）" }, { status: 400 });
}
