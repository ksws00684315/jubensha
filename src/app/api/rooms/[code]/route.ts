import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { parseScriptForRuntime, publicBioText } from "@/core/script/compat";
import { assignCharacterIds, hasDuplicateCharacterIds } from "@/lib/seats";
import { checkRoomRateLimit } from "@/lib/rate-limit";

async function loadRoom(code: string) {
  const room = await db.room.findUnique({
    where: { code: code.toUpperCase() },
    include: { seats: { orderBy: { index: "asc" } }, game: true },
  });
  return room;
}

async function GET_IMPL(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const limited = checkRoomRateLimit(_req);
  if (!limited.ok) return NextResponse.json({ error: "请求过于频繁，请稍后再试" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } });
  const { code } = await ctx.params;
  const url = new URL(_req.url);
  const room = await loadRoom(code);
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });
  const scriptRow = await db.script.findUnique({ where: { id: room.scriptId } });
  if (!scriptRow) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseScriptForRuntime(scriptRow.content);
  const hostAuthorized = Boolean(room.hostToken && (url.searchParams.get("hostToken") ?? _req.headers.get("x-host-token")) === room.hostToken);
  const seatIndex = Number(url.searchParams.get("seat"));
  const seatToken = url.searchParams.get("token") ?? _req.headers.get("x-seat-token");
  const seatAuthorized = Number.isInteger(seatIndex) && room.seats.some((s) => s.index === seatIndex && s.token && s.token === seatToken);
  const dmAuthorized = Boolean(room.dmToken && (url.searchParams.get("dmToken") ?? _req.headers.get("x-dm-token")) === room.dmToken);
  const canSeeNames = hostAuthorized || dmAuthorized;
  return NextResponse.json({
    id: room.id,
    code: room.code,
    status: room.game?.status === "ended" || room.game?.phase === "ENDED" ? "ended" : room.status,
    // gameId 是后续 SSE/动作接口的枚举入口，无凭证时不返回。
    gameId: hostAuthorized || dmAuthorized || seatAuthorized ? room.game?.id ?? null : null,
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
async function PATCH_IMPL(req: Request, ctx: { params: Promise<{ code: string }> }) {
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
  // 创建时校验过的 min/max 在改座位时必须重校验：否则可以把局改成不足开局人数或超出角色数
  const activeCount = parsed.data.seats.filter((s) => s.kind !== "empty").length;
  if (activeCount > doc.characters.length) return NextResponse.json({ error: "非空座位不能超过剧本角色数" }, { status: 400 });
  if (activeCount > doc.meta.maxPlayers) return NextResponse.json({ error: `该剧本最多 ${doc.meta.maxPlayers} 名玩家` }, { status: 400 });
  if (activeCount < doc.meta.minPlayers) return NextResponse.json({ error: `该剧本至少需要 ${doc.meta.minPlayers} 名玩家` }, { status: 400 });

  // 多条座位更新放进一个事务：中途失败不会留下半套座位配置（独立审查 M5）
  await db.$transaction(
    parsed.data.seats.flatMap((s) => {
      const seat = room.seats.find((x) => x.index === s.index);
      if (!seat) return [];
      const characterId = characterIds[ordered.findIndex((x) => x.index === s.index)] ?? null;
      return [
        db.seat.update({
          where: { id: seat.id },
          data: {
            kind: s.kind,
            characterId,
            playerName: s.kind === "human" ? seat.playerName : s.kind === "ai" ? seat.playerName ?? null : null,
            ...(s.kind !== "human" ? { token: null } : {}),
          },
        }),
      ];
    })
  );
  return NextResponse.json({ ok: true });
}

export const GET = withRoute(GET_IMPL);
export const PATCH = withRoute(PATCH_IMPL);
