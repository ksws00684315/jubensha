import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import crypto from "node:crypto";
import { decideJoin } from "@/lib/join";

const joinSchema = z.object({
  code: z.string().min(3),
  name: z.string().min(1).max(20),
});

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

/** 大厅入座；对局已开始则凭房间码 + 原昵称认领回座位（换设备/清缓存后恢复）。 */
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

  const decision = decideJoin(room.status, room.seats, name);
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
    return NextResponse.json({ error: "对局已开始。请填写你入座时用的昵称以回到本局。" }, { status: 400 });
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
