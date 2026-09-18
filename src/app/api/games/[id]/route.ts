import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { locationNameOf, locationNames, narrativeToText, parseScriptForRuntime, publicBioText, timelineToText } from "@/core/script/compat";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import { clueReachable, cluesVisibleToSeat } from "@/core/engine/state";
import { unlockedActs } from "@/core/engine/flow";
import { GameEngine } from "@/core/engine/engine";
import type { GameState } from "@/core/engine/types";

/** 对局概要：阶段、座位、我的角色卡（按 token 鉴权） */
async function GET_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const seatParam = url.searchParams.get("seat");
  // 凭证优先走 header（不进访问日志）；query 为兼容期回退，一个版本后删除
  const token = url.searchParams.get("token") ?? req.headers.get("x-seat-token");

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: { orderBy: { index: "asc" } } } }, script: true } });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });

  // 快照优先；快照或原始剧本任一可解析即可提供服务，全部损坏时降级 503 而不是抛 500
  let doc: ReturnType<typeof parseScriptForRuntime>;
  try {
    doc = parseScriptForRuntime(game.scriptSnapshot ?? game.script.content);
  } catch {
    try {
      doc = parseScriptForRuntime(game.script.content);
    } catch {
      return NextResponse.json({ error: "对局剧本数据损坏，请联系主持人" }, { status: 503 });
    }
  }
  const v2 = publicScriptViewV2(doc);
  let mySeat: number | null = seatParam !== null ? Number(seatParam) : null;
  if (mySeat !== null) {
    const seatRow = game.room.seats.find((s) => s.index === mySeat);
    if (!seatRow || !seatRow.token || seatRow.token !== token) mySeat = null;
  }

  // 只有持有有效座位凭证的参与者才可触发懒恢复；公开观战请求只读快照，避免被匿名轮询唤醒 AI 消耗。
  if (game.status === "running" && mySeat !== null && !GameEngine.get(id)) {
    void GameEngine.load(id).catch(() => null);
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
    availableLocations: (() => {
      // 观战（无有效座位 token）视角一律不下发搜证地点：
      // 否则"还有哪些地点有货、还剩几个"会变成一个免费的情报优势。
      if (mySeat === null) return [];
      const myChar = doc.characters.find((c) => c.id === game.room.seats.find((s2) => s2.index === mySeat)?.characterId);
      const seatChar = myChar?.id ?? null;
      const publicClueIds = new Set(Object.entries(clueStates).filter(([, st]) => (st as { isPublic?: boolean }).isPublic).map(([id]) => id));
      const round = game.round;
      return doc.locations
        .filter((location) => !(seatChar && location.ownerCharacterId === seatChar))
        .filter((location) =>
          doc.clues.some(
            (clue) =>
              clue.locationId === location.id &&
              clueStates[clue.id] === undefined &&
              clueReachable(clue, { seatCharacterId: seatChar, round, publicClueIds }),
          ),
        )
        .map((location) => location.name);
    })(),
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
              secret: c.privateCard.secrets
                .map((secret) => `${secret.title}${secret.disclosure === "conditional" ? `（满足条件后披露：${secret.condition ?? "由主持判断"}）` : secret.disclosure === "must_share" ? "（需要找机会主动披露）" : "（不可主动披露）"}：${narrativeToText(secret.content)}`)
                .join("\n\n"),
              goal: c.privateCard.objectives.map((objective) => `${objective.title}：${narrativeToText(objective.content)}`).join("\n\n"),
              isCulprit: c.privateCard.isCulprit,
              timeline: timelineToText(c.privateCard.timeline),
              knowledge: c.privateCard.knowledge.map((item) => `${item.title}：${narrativeToText(item.content)}`),
              persona: [c.privateCard.persona.speechStyle, ...c.privateCard.persona.traits].filter(Boolean).join("；"),
            }
          : null,
        myCardV2: isMine && c
          ? {
              ...c.privateCard,
              stages: c.privateCard.stages.filter((st) =>
                unlockedActs(doc.flow.acts, runtimeState).some((a) => a.id === st.actId),
              ),
            }
          : null,
      };
    }),
    mySeat,
    myClues: (myState as { clueIds?: string[] } | null)?.clueIds ?? [],
    clues: visibleClues,
    scriptV2: { background: v2.background, characters: v2.characters, locations: v2.locations },
    myCluesV2: doc.clues.filter((clue) => visibleClues.some((visible) => visible.id === clue.id)),
    voteResult: mySeat !== null ? runtimeState.voteResult ?? null : null,
    // 结构化结局：模式 + 答题卡（题面公开不含正确项；myAnswers 仅本人）
    voteMode: doc.flow.voteMode,
    quiz:
      doc.flow.voteMode === "culprit" || doc.ending.quiz.length === 0
        ? null
        : {
            questions: doc.ending.quiz.map((q) => ({
              id: q.id,
              prompt: q.prompt,
              options: q.options.map((o) => ({ id: o.id, label: o.label })),
            })),
            myAnswers: mySeat !== null ? runtimeState.quizAnswers?.[String(mySeat)] ?? null : null,
          },
    quizResult: runtimeState.phase === "ENDED" ? runtimeState.quizResult ?? null : null,
    turnSeat: runtimeState.turnSeat ?? null,
    questionsLeft: mySeat !== null ? runtimeState.questionsLeft?.[String(mySeat)] ?? 0 : 0,
    // 在途质询只发给有座位的参与者：题干本身在公开发言里，但"谁被问、还没答"不该给观战者看
    pendingAnswer: mySeat !== null ? runtimeState.pendingAnswer ?? null : null,
    // 技能卡（仅本人可见自己的卡）：阶段/点数/once 计算可用性
    skills: (() => {
      if (mySeat === null || doc.flow.actionPointsPerRound <= 0) return [];
      const me = doc.characters.find((c) => c.id === game.room.seats.find((s2) => s2.index === mySeat)?.characterId);
      if (!me) return [];
      const left = runtimeState.actionPoints?.[String(mySeat)] ?? 0;
      const used = runtimeState.usedSkills ?? [];
      return me.privateCard.skills.map((skill) => ({
        ...skill,
        usable:
          skill.phase === game.phase &&
          (!skill.once || !used.includes(`${mySeat}:${skill.id}`)) &&
          skill.cost <= left,
      }));
    })(),
    actionPointsLeft: mySeat !== null && doc.flow.actionPointsPerRound > 0 ? runtimeState.actionPoints?.[String(mySeat)] ?? 0 : 0,
    humanDeadline: mySeat !== null ? runtimeState.humanDeadlines?.[String(mySeat)] ?? null : null,
    // 推荐回复：轮到我发言时后台生成的建议短句
    suggestions: mySeat !== null ? runtimeState.suggestions?.[String(mySeat)] ?? [] : [],
    // 向我开过私信窗口的 AI 座位列表（可回复）
    openWhispers:
      mySeat !== null
        ? Object.entries(runtimeState.privateChat ?? {})
            .filter(([key, count]) => Number(count) > 0 && Number(key.split("-")[1]) === mySeat)
            .map(([key]) => Number(key.split("-")[0]))
        : [],
  });
}

export const GET = withRoute(GET_IMPL);
