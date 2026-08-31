import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { GameEngine, type GameAction } from "@/core/engine/engine";

const actionSchema = z.object({
  seatIndex: z.number().int().min(0),
  token: z.string().min(1),
  action: z.object({
    type: z.enum(["ready", "speak", "choose_location", "publish", "vote", "private_chat", "rush"]),
    text: z.string().optional(),
    location: z.string().optional(),
    clueId: z.string().optional(),
    publish: z.boolean().optional(),
    target: z.number().int().optional(),
    reason: z.string().optional(),
    toSeat: z.number().int().optional(),
  }),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const { seatIndex, token, action } = parsed.data;
  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: true } } } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });

  const seatRow = game.room.seats.find((s) => s.index === seatIndex);
  if (!seatRow || !seatRow.token || seatRow.token !== token) {
    return NextResponse.json({ error: "座位鉴权失败" }, { status: 403 });
  }

  const engine = GameEngine.get(id) ?? (await GameEngine.load(id));
  const result = await engine.handleAction(seatIndex, action as GameAction);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
