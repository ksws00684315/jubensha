import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { locationNameOf, locationNames, narrativeToText, parseScriptForRuntime, publicBioText } from "@/core/script/compat";
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

  const doc = parseScriptForRuntime(game.script.content);
  const v2 = publicScriptViewV2(doc);
  let mySeat: number | null = seatParam !== null ? Number(seatParam) : null;
  if (mySeat !== null) {
    const seatRow = game.room.seats.find((s) => s.index === mySeat);
    if (!seatRow || !seatRow.token || seatRow.token !== token) mySeat = null;
  }

  const seatStates = await db.seatState.findMany({ where: { gameId: id } });
  const runtimeState = (game.state as unknown as GameState) ?? { clueStates: {}, heldClues: {} };
  const clueStates = runtimeState.clueStates ?? {};
  const myState = mySeat !== null ? seatStates.find((s) => s.seatIndex === mySeat)?.data : null;

  const visibleClues = mySeat !== null
    ? cluesVisibleToSeat(
        doc.clues.map((clue) => ({ id: clue.id, name: clue.name, location: locationNameOf(doc, clue.locationId) })),
        runtimeState,
        mySeat,
      )
    : [];

  return NextResponse.json({
    id: game.id,
    roomId: game.room.id,
    roomCode: game.room.code,
    status: game.status,
    phase: game.phase,
    round: game.round,
    scriptTitle: doc.meta.title,
    background: narrativeToText(doc.background),
    flow: doc.flow,
    locations: locationNames(doc),
    availableLocations: doc.locations
      .filter((location) => doc.clues.some((clue) => clue.locationId === location.id && clueStates[clue.id] === undefined))
      .map((location) => location.name),
    seats: game.room.seats.map((s) => {
      const c = doc.characters.find((ch) => ch.id === s.characterId);
      const isMine = mySeat === s.index;
      return {
        index: s.index,
        kind: s.kind,
        playerName: s.playerName,
        characterName: c?.name ?? null,
        characterPublicBio: !isMine && c ? publicBioText(c) : null,
        myCard: isMine && c
          ? {
              backstory: narrativeToText(c.privateCard.backstory),
              secret: c.privateCard.secrets.map((secret) => `${secret.title}：${narrativeToText(secret.content)}`).join("\n\n"),
              goal: c.privateCard.objectives.map((objective) => `${objective.title}：${narrativeToText(objective.content)}`).join("\n\n"),
              isCulprit: c.privateCard.isCulprit,
              timeline: c.privateCard.timeline.map((entry) => `${entry.time.display} ${entry.title}：${narrativeToText(entry.content)}`).join("\n"),
              knowledge: c.privateCard.knowledge.map((item) => `${item.title}：${narrativeToText(item.content)}`),
              persona: [c.privateCard.persona.speechStyle, ...c.privateCard.persona.traits].filter(Boolean).join("；"),
            }
          : null,
        myCardV2: isMine && c ? c.privateCard : null,
      };
    }),
    mySeat,
    myClues: (myState as { clueIds?: string[] } | null)?.clueIds ?? [],
    clues: visibleClues,
    scriptV2: { background: v2.background, characters: v2.characters, locations: v2.locations },
    myCluesV2: doc.clues.filter((clue) => visibleClues.some((visible) => visible.id === clue.id)),
    voteResult: mySeat !== null ? runtimeState.voteResult ?? null : null,
  });
}
