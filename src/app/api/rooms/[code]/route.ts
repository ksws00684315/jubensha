import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseScriptForRuntime, publicBioText } from "@/core/script/compat";
import { assignCharacterIds, hasDuplicateCharacterIds } from "@/lib/seats";

async function loadRoom(code: string) {
  const room = await db.room.findUnique({
    where: { code: code.toUpperCase() },
    include: { seats: { orderBy: { index: "asc" } }, game: true },
  });
  return room;
}

export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const url = new URL(_req.url);
  const room = await loadRoom(code);
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });
  const scriptRow = await db.script.findUnique({ where: { id: room.scriptId } });
  if (!scriptRow) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseScriptForRuntime(scriptRow.content);
  const hostAuthorized = Boolean(room.hostToken && url.searchParams.get("hostToken") === room.hostToken);
  const seatIndex = Number(url.searchParams.get("seat"));
  const seatAuthorized = Number.isInteger(seatIndex) && room.seats.some((s) => s.index === seatIndex && s.token && s.token === url.searchParams.get("token"));
  const dmAuthorized = Boolean(room.dmToken && room.dmToken === url.searchParams.get("dmToken"));
  const canSeeNames = hostAuthorized || dmAuthorized;
  return NextResponse.json({
    id: room.id,
    code: room.code,
    status: room.game?.status === "ended" || room.game?.phase === "ENDED" ? "ended" : room.status,
    gameId: room.game?.id ?? null,
    gamePhase: room.game?.phase ?? null,
    humanDm: room.humanDm,
    dmTaken: Boolean(room.dmToken),
    dmName: canSeeNames ? room.dmName : null,
    script: { id: scriptRow.id, title: doc.meta.title, intro: doc.meta.intro, difficulty: doc.meta.difficulty, durationMin: doc.meta.durationMin },
    seats: room.seats.map((s) => {
      const c = doc.characters.find((ch) => ch.id === s.characterId);
      return {
        index: s.index,
        kind: s.kind,
        playerName: canSeeNames || (seatAuthorized && s.index === seatIndex) ? s.playerName : null,
        hasToken: Boolean(s.token),
        character: c ? { id: c.id, name: c.name, publicBio: publicBioText(c) } : null,
      };
    }),
    characters: doc.characters.map((c) => ({ id: c.id, name: c.name, publicBio: publicBioText(c) })),
  });
}

const patchSchema = z.object({
  hostToken: z.string().min(1),
  seats: z
    .array(z.object({ index: z.number().int(), kind: z.enum(["human", "ai", "empty"]), characterId: z.string().nullable().optional() }))
    .min(3)
    .max(8),
});

/** 更新座位配置（仅大厅阶段） */
export async function PATCH(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const room = await loadRoom(code);
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });
  if (room.status !== "lobby") return NextResponse.json({ error: "对局已开始" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  if (!room.hostToken || room.hostToken !== parsed.data.hostToken) {
    return NextResponse.json({ error: "只有房主可以改座位" }, { status: 403 });
  }

  const scriptRow = await db.script.findUnique({ where: { id: room.scriptId } });
  if (!scriptRow) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseScriptForRuntime(scriptRow.content);
  const ordered = parsed.data.seats.slice().sort((a, b) => a.index - b.index);
  const validCharacterIds = new Set(doc.characters.map((c) => c.id));
  if (parsed.data.seats.some((s) => s.kind !== "empty" && s.characterId && !validCharacterIds.has(s.characterId))) {
    return NextResponse.json({ error: "座位角色不属于该剧本" }, { status: 400 });
  }
  const characterIds = assignCharacterIds(ordered, doc.characters.map((c) => c.id));
  if (hasDuplicateCharacterIds(characterIds)) {
    return NextResponse.json({ error: "座位角色不能重复" }, { status: 400 });
  }

  for (const s of parsed.data.seats) {
    const seat = room.seats.find((x) => x.index === s.index);
    if (!seat) continue;
    const characterId = characterIds[ordered.findIndex((x) => x.index === s.index)] ?? null;
    await db.seat.update({
      where: { id: seat.id },
      data: {
        kind: s.kind,
        characterId,
        playerName: s.kind === "human" ? seat.playerName : s.kind === "ai" ? seat.playerName ?? null : null,
        ...(s.kind !== "human" ? { token: null } : {}),
      },
    });
  }
  return NextResponse.json({ ok: true });
}
