import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseScriptDoc } from "@/core/script/schema";
import { isScriptPlayable } from "@/core/script/validate";
import { GameEngine } from "@/core/engine/engine";
import { hasDuplicateCharacterIds } from "@/lib/seats";

const startSchema = z.object({ hostToken: z.string().min(1) });

/** 开局：校验座位与剧本，创建引擎并自动开始 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = startSchema.safeParse(body ?? {});
  if (!parsed.success) return NextResponse.json({ error: "缺少房主凭证" }, { status: 400 });
  const room = await db.room.findUnique({
    where: { code: code.toUpperCase() },
    include: { seats: { orderBy: { index: "asc" } } },
  });
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });
  if (!room.hostToken || room.hostToken !== parsed.data.hostToken) {
    return NextResponse.json({ error: "只有房主可以开局" }, { status: 403 });
  }
  const existingGame = await db.game.findUnique({ where: { roomId: room.id } });
  if (existingGame) return NextResponse.json({ gameId: existingGame.id, error: "对局已存在" }, { status: 400 });

  const scriptRow = await db.script.findUnique({ where: { id: room.scriptId } });
  if (!scriptRow) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseScriptDoc(scriptRow.content);
  const play = isScriptPlayable(doc);
  if (!play.ok) return NextResponse.json({ error: "剧本校验失败", issues: play.errors }, { status: 400 });

  const seats = room.seats.sort((a, b) => a.index - b.index);
  // 校验：座位从 0 连续、无空座夹心、每个非空座位都有角色
  for (let i = 0; i < seats.length; i++) {
    if (seats[i].index !== i) return NextResponse.json({ error: "座位配置有误：座位必须从 0 开始连续" }, { status: 400 });
  }
  const actives = seats.filter((s) => s.kind !== "empty");
  if (actives.length < doc.meta.minPlayers) return NextResponse.json({ error: `至少需要 ${doc.meta.minPlayers} 名玩家` }, { status: 400 });
  for (const s of actives) {
    if (!s.characterId) return NextResponse.json({ error: `座位 ${s.index + 1} 未分配角色` }, { status: 400 });
  }
  if (hasDuplicateCharacterIds(actives.map((s) => s.characterId))) {
    return NextResponse.json({ error: "座位角色不能重复" }, { status: 400 });
  }
  for (const s of actives) {
    if (s.kind === "human" && !s.token) {
      return NextResponse.json({ error: `座位 ${s.index + 1} 的真人玩家尚未入座` }, { status: 400 });
    }
  }
  // 真人座位应有名字（加入时填）；AI 座位补默认名
  for (const s of seats) {
    if (s.kind === "ai" && !s.playerName) {
      const c = doc.characters.find((ch) => ch.id === s.characterId);
      await db.seat.update({ where: { id: s.id }, data: { playerName: `${c?.name ?? "AI"}（AI）` } });
    }
  }

  await db.room.update({ where: { id: room.id }, data: { status: "playing" } });
  const engine = await GameEngine.start({ ...room, seats }, { id: scriptRow.id, content: scriptRow.content });
  return NextResponse.json({ gameId: engine.gameId }, { status: 201 });
}
