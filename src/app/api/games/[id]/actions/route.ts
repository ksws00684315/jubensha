import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { GameEngine, type GameAction } from "@/core/engine/engine";
import { checkActionRateLimit } from "@/lib/rate-limit";

const actionSchema = z.object({
  seatIndex: z.number().int().min(0),
  token: z.string().min(1),
  action: z.object({
    type: z.enum(["ready", "speak", "skip", "ask", "choose_location", "publish", "vote", "private_chat", "rush", "transfer", "use_skill", "answer_quiz", "interaction"]),
    beatId: z.string().optional(),
    choiceId: z.string().optional(),
    evidenceIds: z.array(z.string()).max(100).optional(),
    text: z.string().optional(),
    location: z.string().optional(),
    clueId: z.string().optional(),
    skillId: z.string().optional(),
    answers: z.array(z.object({ questionId: z.string(), optionId: z.string() })).optional(),
    publish: z.boolean().optional(),
    target: z.number().int().optional(),
    reason: z.string().optional(),
    toSeat: z.number().int().optional(),
  }),
});

async function POST_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = checkActionRateLimit(req);
  if (!limited.ok) return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } });
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

  let engine: GameEngine;
  try {
    engine = GameEngine.get(id) ?? (await GameEngine.load(id));
  } catch {
    // 损坏/legacy 快照会让 load 抛错；动作接口给出可重试的 503 而非裸 500
    return NextResponse.json({ error: "对局状态暂时无法恢复，请稍后重试" }, { status: 503 });
  }
  const result = await engine.handleAction(seatIndex, action as GameAction);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

export const POST = withRoute(POST_IMPL);
