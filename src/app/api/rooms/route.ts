import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { parseScriptForRuntime } from "@/core/script/compat";
import { isScriptPlayable } from "@/core/script/v2/validate";
import { assignCharacterIds, hasDuplicateCharacterIds } from "@/lib/seats";
import { checkCreateRoomRateLimit } from "@/lib/rate-limit";

const seatSchema = z.object({
  kind: z.enum(["human", "ai", "empty"]),
  characterId: z.string().nullable().optional(),
});

const createSchema = z.object({
  scriptId: z.string().min(1),
  seats: z.array(seatSchema).min(3).max(8),
  humanDm: z.boolean().optional(),
  unlimitedHumanTurns: z.boolean().optional(),
});

function genRoomCode(): string {
  const chars = "ACDEFGHJKLMNPQRTUVWXY34679"; // 去掉易混淆字符
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

/** 创建房间 */
async function POST_IMPL(req: Request) {
  const limited = checkCreateRoomRateLimit(req);
  if (!limited.ok) return NextResponse.json({ error: "创建过于频繁，请稍后再试" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } });
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const scriptRow = await db.script.findFirst({ where: { id: parsed.data.scriptId, deleted: false } });
  if (!scriptRow) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseScriptForRuntime(scriptRow.content);
  if (parsed.data.seats.length < doc.meta.minPlayers || parsed.data.seats.length > doc.meta.maxPlayers) {
    return NextResponse.json({ error: `该剧本需要 ${doc.meta.minPlayers}-${doc.meta.maxPlayers} 名玩家` }, { status: 400 });
  }
  const play = isScriptPlayable(doc);
  if (!play.ok) return NextResponse.json({ error: "剧本校验失败", issues: play.errors }, { status: 400 });

  const validCharacterIds = new Set(doc.characters.map((c) => c.id));
  if (parsed.data.seats.some((s) => s.kind !== "empty" && s.characterId && !validCharacterIds.has(s.characterId))) {
    return NextResponse.json({ error: "座位角色不属于该剧本" }, { status: 400 });
  }

  const characterIds = assignCharacterIds(parsed.data.seats, doc.characters.map((c) => c.id));
  if (hasDuplicateCharacterIds(characterIds)) {
    return NextResponse.json({ error: "座位角色不能重复" }, { status: 400 });
  }

  let code = genRoomCode();
  const hostToken = crypto.randomBytes(16).toString("hex");
  // findUnique 预检查不是原子的：并发下以 code 唯一约束为准，撞码就换新码重试（独立审查 M5）
  let room: Awaited<ReturnType<typeof db.room.create>> | null = null;
  for (let attempt = 0; attempt < 5 && !room; attempt++) {
    if (attempt > 0) code = genRoomCode();
    try {
      room = await db.room.create({
        data: {
          code,
          scriptId: scriptRow.id,
          humanDm: parsed.data.humanDm ?? false,
          unlimitedHumanTurns: parsed.data.unlimitedHumanTurns ?? true,
          hostToken,
          seats: {
            create: parsed.data.seats.map((s, index) => ({
              index,
              kind: s.kind,
              playerName: null,
              characterId: characterIds[index],
            })),
          },
        },
        include: { seats: true },
      });
    } catch (err) {
      const isLastAttempt = attempt === 4;
      if (isLastAttempt || (err && typeof err === "object" && (err as { code?: string }).code !== "P2002")) throw err;
    }
  }
  return NextResponse.json({ roomId: room!.id, code: room!.code, hostToken }, { status: 201 });
}

export const POST = withRoute(POST_IMPL);
