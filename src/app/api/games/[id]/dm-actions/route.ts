import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { clueText, locationNameOf, narrativeToText, parseScriptForRuntime, publicBioText, timelineToText } from "@/core/script/compat";
import { GameEngine } from "@/core/engine/engine";

const actionSchema = z.object({
  token: z.string().min(1),
  action: z.object({
    type: z.enum(["narrate", "nudge", "skip_turn", "handout", "hint", "force_ready", "abort_game"]),
    text: z.string().optional(),
    clueId: z.string().optional(),
    hintIndex: z.number().int().min(0).optional(),
    seatIndex: z.number().int().min(0).max(7).optional(),
  }),
});

/** 真人 DM 动作：播旁白 / 催促引擎 / 跳过卡住的回合 */
async function POST_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const game = await db.game.findUnique({ where: { id }, include: { room: true } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });
  if (!game.room.humanDm || !game.room.dmToken || game.room.dmToken !== parsed.data.token) {
    return NextResponse.json({ error: "DM 鉴权失败" }, { status: 403 });
  }

  let engine: GameEngine;
  try {
    engine = GameEngine.get(id) ?? (await GameEngine.load(id));
  } catch {
    return NextResponse.json({ error: "对局状态暂时无法恢复，请稍后重试" }, { status: 503 });
  }
  const result = await engine.handleDmAction(parsed.data.action);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

/** 真人 DM 的全知视图：真相、全部线索、全部角色卡 */
async function GET_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? req.headers.get("x-dm-token");

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: { orderBy: { index: "asc" } } } }, script: true, votes: true } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });
  if (!game.room.humanDm || !game.room.dmToken || game.room.dmToken !== token) {
    return NextResponse.json({ error: "DM 鉴权失败" }, { status: 403 });
  }

  const doc = parseScriptForRuntime(game.scriptSnapshot ?? game.script.content);
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
    votes: (() => {
      // 引擎在内存中以 state.votes 为权威（表写入可能失败）；引擎不常驻时回落到 Vote 表
      const live = GameEngine.get(id);
      if (live) {
        return Object.entries(live.state.votes).map(([seat, v]) => ({ seatIndex: Number(seat), targetIndex: v.target, reason: v.reason }));
      }
      return game.votes.map((v) => ({ seatIndex: v.seatIndex, targetIndex: v.targetIndex, reason: v.reason }));
    })(),
    hostGuide: doc.hostGuide ?? null,
  });
}

export const POST = withRoute(POST_IMPL);
export const GET = withRoute(GET_IMPL);
