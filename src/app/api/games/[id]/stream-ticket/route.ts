import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { checkStreamTicketRateLimit } from "@/lib/rate-limit";
import { verifyDmToken, verifySeatToken } from "@/lib/credentials";
import { issueStreamTicket } from "@/lib/stream-tickets";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  seat: z.number().int().min(0).max(7).nullish(),
  dm: z.boolean().nullish(),
});

/**
 * 换票：长期凭证只走请求头（不进访问日志），换回一张 60 秒、一次性的 ticket，
 * 由前端放进 SSE 地址。要看的视角（哪个座位 / 是否主持）在签发时就定死在票据里，
 * 订阅端不能再自行声明。
 */
async function POST_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = checkStreamTicketRateLimit(req);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "订阅凭证获取过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: true } } } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });

  const seatToken = req.headers.get("x-seat-token");
  const seat = parsed.data.seat;
  if (seat !== null && seat !== undefined && seatToken && verifySeatToken(game.room.seats, seat, seatToken)) {
    const { ticket, expiresAt } = issueStreamTicket(id, { kind: "seat", seat, credential: seatToken });
    return NextResponse.json({ ticket, expiresAt });
  }

  const dmToken = req.headers.get("x-dm-token");
  if (parsed.data.dm && game.room.humanDm && dmToken && verifyDmToken(game.room, dmToken)) {
    const { ticket, expiresAt } = issueStreamTicket(id, { kind: "dm", credential: dmToken });
    return NextResponse.json({ ticket, expiresAt });
  }

  return NextResponse.json({ error: "凭证校验失败" }, { status: 403 });
}

export const POST = withRoute(POST_IMPL);
