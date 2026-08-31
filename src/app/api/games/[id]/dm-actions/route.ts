import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { clueText, locationNameOf, narrativeToText, parseScriptForRuntime, publicBioText, timelineToText } from "@/core/script/compat";
import { GameEngine } from "@/core/engine/engine";

const actionSchema = z.object({
  token: z.string().min(1),
  action: z.object({
    type: z.enum(["narrate", "nudge", "skip_turn"]),
    text: z.string().optional(),
  }),
});

/** 真人 DM 动作：播旁白 / 催促引擎 / 跳过卡住的回合 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const game = await db.game.findUnique({ where: { id }, include: { room: true } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });
  if (!game.room.humanDm || !game.room.dmToken || game.room.dmToken !== parsed.data.token) {
    return NextResponse.json({ error: "DM 鉴权失败" }, { status: 403 });
  }

  const engine = GameEngine.get(id) ?? (await GameEngine.load(id));
  const result = await engine.handleDmAction(parsed.data.action);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

/** 真人 DM 的全知视图：真相、全部线索、全部角色卡 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: { orderBy: { index: "asc" } } } }, script: true, votes: true } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });
  if (!game.room.humanDm || !game.room.dmToken || game.room.dmToken !== token) {
    return NextResponse.json({ error: "DM 鉴权失败" }, { status: 403 });
  }

  const doc = parseScriptForRuntime(game.script.content);
  return NextResponse.json({
    truth: {
      culprit: doc.truth.culpritId,
      method: narrativeToText(doc.truth.method.summary),
      fullTimeline: doc.truth.timeline.map((entry) => `${entry.time.display} ${entry.title}：${narrativeToText(entry.content)}`).join("\n"),
      keyEvidence: doc.truth.keyEvidenceIds.map((id) => doc.clues.find((clue) => clue.id === id)?.name ?? id),
      reveal: narrativeToText(doc.truth.reveal),
    },
    characters: doc.characters.map((c) => ({
      id: c.id,
      name: c.name,
      publicBio: publicBioText(c),
      secret: c.privateCard.secrets.map((secret) => `${secret.title}：${narrativeToText(secret.content)}`).join("\n\n"),
      goal: c.privateCard.objectives.map((objective) => `${objective.title}：${narrativeToText(objective.content)}`).join("\n\n"),
      timeline: timelineToText(c.privateCard.timeline),
      isCulprit: c.privateCard.isCulprit,
      seatIndex: game.room.seats.find((s) => s.characterId === c.id)?.index ?? null,
    })),
    clues: doc.clues.map((clue) => ({
      id: clue.id,
      location: locationNameOf(doc, clue.locationId),
      name: clue.name,
      content: clueText(clue),
      policy: clue.policy,
    })),
    structured: {
      truth: doc.truth,
      characters: doc.characters.map((character) => ({
        id: character.id,
        name: character.name,
        publicProfile: character.publicProfile,
        privateCard: character.privateCard,
        seatIndex: game.room.seats.find((seat) => seat.characterId === character.id)?.index ?? null,
      })),
      clues: doc.clues,
    },
    votes: game.votes.map((v) => ({ seatIndex: v.seatIndex, targetIndex: v.targetIndex, reason: v.reason })),
  });
}
