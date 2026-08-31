import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { parseScriptForRuntime } from "@/core/script/compat";
import { isScriptPlayable } from "@/core/script/validate";
import { assignCharacterIds, hasDuplicateCharacterIds } from "@/lib/seats";

const seatSchema = z.object({
  kind: z.enum(["human", "ai", "empty"]),
  characterId: z.string().nullable().optional(),
});

const createSchema = z.object({
  scriptId: z.string().min(1),
  seats: z.array(seatSchema).min(3).max(8),
  humanDm: z.boolean().optional(),
});

function genRoomCode(): string {
  const chars = "ACDEFGHJKLMNPQRTUVWXY34679"; // 去掉易混淆字符
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/** 创建房间 */
export async function POST(req: Request) {
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
  for (let i = 0; i < 5; i++) {
    const exists = await db.room.findUnique({ where: { code } });
    if (!exists) break;
    code = genRoomCode();
  }

  const hostToken = crypto.randomBytes(16).toString("hex");
  const room = await db.room.create({
    data: {
      code,
      scriptId: scriptRow.id,
      humanDm: parsed.data.humanDm ?? false,
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
  return NextResponse.json({ roomId: room.id, code: room.code, hostToken }, { status: 201 });
}
