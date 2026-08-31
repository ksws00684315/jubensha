import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import crypto from "node:crypto";

const joinSchema = z.object({
  code: z.string().min(3),
  name: z.string().min(1).max(20),
});

/** 凭房间码加入：分配一个尚未认领的真人座位，返回座位 token */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = joinSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const room = await db.room.findUnique({ where: { code: parsed.data.code.toUpperCase() }, include: { seats: { orderBy: { index: "asc" } } } });
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });
  if (room.status !== "lobby") return NextResponse.json({ error: "对局已开始，无法加入" }, { status: 400 });

  const token = crypto.randomBytes(16).toString("hex");
  const openSeats = room.seats.filter((s) => s.kind === "human" && !s.token);
  if (!openSeats.length) return NextResponse.json({ error: "房间已满（没有空的真人座位）" }, { status: 400 });

  for (const openSeat of openSeats) {
    const claimed = await db.seat.updateMany({
      where: { id: openSeat.id, token: null, kind: "human" },
      data: { playerName: parsed.data.name, token },
    });
    if (claimed.count !== 1) continue;
    const seat = await db.seat.findUnique({ where: { id: openSeat.id } });
    if (!seat) continue;
    return NextResponse.json({ roomId: room.id, seatIndex: seat.index, token, characterId: seat.characterId });
  }
  return NextResponse.json({ error: "房间已满（没有空的真人座位）" }, { status: 400 });
}
