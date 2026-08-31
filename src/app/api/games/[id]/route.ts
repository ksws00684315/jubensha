import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { legacyScriptDocOf, parseAnyScriptDoc } from "@/core/script/compat";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import { cluesVisibleToSeat } from "@/core/engine/state";
import type { GameState } from "@/core/engine/types";

/** 对局概要：阶段、座位、我的角色卡（按 token 鉴权） */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const seatParam = url.searchParams.get("seat");
  const token = url.searchParams.get("token");

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: { orderBy: { index: "asc" } } } }, script: true } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });

  const parsed = parseAnyScriptDoc(game.script.content);
  const doc = legacyScriptDocOf(parsed.doc);
  const v2 = parsed.version === 2 ? publicScriptViewV2(parsed.doc) : null;
  let mySeat: number | null = seatParam !== null ? Number(seatParam) : null;
  if (mySeat !== null) {
    const seatRow = game.room.seats.find((s) => s.index === mySeat);
    if (!seatRow || !seatRow.token || seatRow.token !== token) mySeat = null; // 鉴权失败按观战处理
  }

  const seatStates = await db.seatState.findMany({ where: { gameId: id } });
  const myState = mySeat !== null ? seatStates.find((s) => s.seatIndex === mySeat)?.data : null;

  const visibleClues = mySeat !== null ? cluesVisibleToSeat(doc.clues, (game.state as unknown as GameState) ?? { clueStates: {}, heldClues: {} }, mySeat) : [];

  return NextResponse.json({
    id: game.id,
    roomId: game.room.id,
    roomCode: game.room.code,
    status: game.status,
    phase: game.phase,
    round: game.round,
    scriptTitle: doc.meta.title,
    background: doc.background,
    flow: doc.flow,
    locations: doc.locations,
    seats: game.room.seats.map((s) => {
      const c = doc.characters.find((ch) => ch.id === s.characterId);
      const isMine = mySeat === s.index;
      return {
        index: s.index,
        kind: s.kind,
        playerName: s.playerName,
        characterName: c?.name ?? null,
        characterPublicBio: !isMine && c ? c.publicBio : null,
        // 私卡只有本座位可看
        myCard: isMine && c ? c.card : null,
        myCardV2: isMine && parsed.version === 2 && s.characterId ? parsed.doc.characters.find((character) => character.id === s.characterId)?.privateCard ?? null : null,
      };
    }),
    mySeat,
    myClues: (myState as { clueIds?: string[] } | null)?.clueIds ?? [],
    clues: visibleClues,
    scriptV2: v2 ? { background: v2.background, characters: v2.characters, locations: v2.locations } : null,
    myCluesV2: parsed.version === 2 ? parsed.doc.clues.filter((clue) => visibleClues.some((visible) => visible.id === clue.id)) : [],
    voteResult: (game.state as { voteResult?: unknown }).voteResult ?? null,
  });
}
