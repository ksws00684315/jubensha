import {
  locationNameOf,
  locationNames,
  narrativeToText,
  publicBioText,
  timelineToText,
} from "@/core/script/compat";
import { publicScriptViewV2, type ScriptDocV2 } from "@/core/script/v2/schema";
import { cluesVisibleToSeat } from "./state";
import { searchLocationOptions } from "./search-locations";
import { unlockedActs } from "./flow";
import { buildSeatSettlement } from "./settlement";
import type { Game, Room, Seat } from "@prisma/client";
import type { GameState } from "./types";

type SeatViewGame = Pick<
  Game,
  "id" | "roomId" | "status" | "phase" | "round" | "createdAt" | "endedAt"
> & {
  room: Pick<Room, "id" | "code"> & { seats: Seat[] };
};

export function buildSeatView(args: {
  game: SeatViewGame;
  doc: ScriptDocV2;
  runtimeState: GameState;
  mySeat: number | null;
}) {
  const { game, doc, runtimeState, mySeat } = args;
  const v2 = publicScriptViewV2(doc);
  const clueStates = runtimeState.clueStates ?? {};

  const mySeatCharacterId =
    mySeat !== null
      ? (game.room.seats.find((s) => s.index === mySeat)?.characterId ?? null)
      : null;

  const searchOptions =
    mySeat === null
      ? []
      : searchLocationOptions({
          locations: doc.locations,
          clues: doc.clues,
          clueStates,
          seatCharacterId: mySeatCharacterId,
          round: game.round,
        });

  const publicEvidenceIds = new Set(
    doc.clues
      .filter((clue) => clueStates[clue.id]?.isPublic)
      .map((clue) => clue.id),
  );

  const myVote =
    mySeat !== null ? (runtimeState.votes?.[String(mySeat)] ?? null) : null;

  const voteResult = mySeat !== null ? (runtimeState.voteResult ?? null) : null;

  const { settlement, culpritSettlement } = buildSeatSettlement({
    doc,
    mySeat,
    myCharacterId: mySeatCharacterId,
    voteResult,
    publicEvidenceIds,
    myVote,
  });

  const visibleClues =
    mySeat !== null
      ? cluesVisibleToSeat(
          doc.clues.map((clue) => ({
            id: clue.id,
            name: clue.name,
            location: locationNameOf(doc, clue.locationId),
          })),
          runtimeState,
          mySeat,
        )
      : [];
  return {
    id: game.id,
    roomId: game.room.id,
    roomCode: game.room.code,
    status: game.status,
    phase: game.phase,
    round: game.round,
    scriptTitle: doc.meta.title,
    background: narrativeToText(doc.background),
    flow: {
      ...doc.flow,
      interactionBeats: doc.flow.interactionBeats?.filter(
        (beat) => beat.visibility === "public",
      ),
    },
    locations: locationNames(doc),
    startedAt: game.createdAt.toISOString(),
    endedAt: game.endedAt?.toISOString() ?? null,
    elapsedMs: Math.max(
      0,
      (game.endedAt?.getTime() ?? Date.now()) - game.createdAt.getTime(),
    ),
    availableLocations: searchOptions
      .filter((option) => option.status === "available")
      .map((option) => option.name),
    searchExhausted:
      mySeat !== null &&
      !searchOptions.some((option) => option.status === "available"),
    searchLocationOptions: searchOptions,
    seats: game.room.seats.map((s) => {
      const c = doc.characters.find((ch) => ch.id === s.characterId);
      const isMine = mySeat === s.index;
      return {
        index: s.index,
        kind: s.kind,
        playerName: s.playerName,
        characterName: c?.name ?? null,
        characterPublicBio: !isMine && c ? publicBioText(c) : null,
        myCard:
          isMine && c
            ? {
                backstory: narrativeToText(c.privateCard.backstory),
                secret: c.privateCard.secrets
                  .map(
                    (secret) =>
                      `${secret.title}${secret.disclosure === "conditional" ? `（满足条件后披露：${secret.condition ?? "由主持判断"}）` : secret.disclosure === "must_share" ? "（需要找机会主动披露）" : "（不可主动披露）"}：${narrativeToText(secret.content)}`,
                  )
                  .join("\n\n"),
                goal: c.privateCard.objectives
                  .map(
                    (objective) =>
                      `${objective.title}：${narrativeToText(objective.content)}`,
                  )
                  .join("\n\n"),
                isCulprit: c.privateCard.isCulprit,
                timeline: timelineToText(c.privateCard.timeline),
                knowledge: c.privateCard.knowledge.map(
                  (item) => `${item.title}：${narrativeToText(item.content)}`,
                ),
                persona: [
                  c.privateCard.persona.speechStyle,
                  ...c.privateCard.persona.traits,
                ]
                  .filter(Boolean)
                  .join("；"),
              }
            : null,
        myCardV2:
          isMine && c
            ? {
                ...c.privateCard,
                stages: c.privateCard.stages.filter((st) =>
                  unlockedActs(doc.flow.acts, runtimeState).some(
                    (a) => a.id === st.actId,
                  ),
                ),
              }
            : null,
      };
    }),
    publicEvidence: doc.clues
      .filter((clue) => clueStates[clue.id]?.isPublic)
      .map(({ id, name }) => ({ id, name })),
    guaranteedDeadlines: Object.fromEntries(
      (doc.hostGuide?.guaranteedPublicClues ?? []).map((item) => [
        item.clueId,
        item.deadlineRound,
      ]),
    ),
    pendingPublishClueIds:
      mySeat !== null
        ? (runtimeState.pendingPublish?.[String(mySeat)] ?? [])
        : [],
    pendingInteraction:
      runtimeState.pendingInteraction?.seatIndex === mySeat
        ? (doc.flow.interactionBeats?.find(
            (beat) => beat.id === runtimeState.pendingInteraction?.beatId,
          ) ?? null)
        : null,
    mySeat,
    myClues: mySeat !== null ? (runtimeState.heldClues?.[mySeat] ?? []) : [],
    clues: visibleClues,
    scriptV2: {
      background: v2.background,
      characters: v2.characters,
      locations: v2.locations,
    },
    myCluesV2: doc.clues
      .filter((clue) => visibleClues.some((visible) => visible.id === clue.id))
      .map(({ id, name, locationId, category, content, policy }) => ({
        id,
        name,
        locationId,
        locationName: locationNameOf(doc, locationId),
        // 区分"在我手里（我搜出/他人面交）"与"仅全场公示"（T3.1）
        held: (runtimeState.heldClues?.[mySeat ?? -1] ?? []).includes(id),
        category,
        content,
        policy,
      })),
    voteResult,
    // 我这一票（投票后可确认已生效；ENDED 查询时仍可回看）。T3.1：此前该值算了没返回，
    // 客户端无法判断"我投过没有"，出现"投票成功仍提示待投票"。
    myVote: myVote ?? null,
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
            myAnswers:
              mySeat !== null
                ? (runtimeState.quizAnswers?.[String(mySeat)] ?? null)
                : null,
          },
    quizResult:
      runtimeState.phase === "ENDED" ? (runtimeState.quizResult ?? null) : null,
    settlement,
    culpritSettlement,
    // 终局后"轮到谁发言"已无意义，清零避免客户端残留"轮到你"提示（T3.1 实测）
    turnSeat: game.status === "ended" ? null : (runtimeState.turnSeat ?? null),
    questionsLeft:
      mySeat !== null ? (runtimeState.questionsLeft?.[String(mySeat)] ?? 0) : 0,
    // 在途质询只发给有座位的参与者：题干本身在公开发言里，但"谁被问、还没答"不该给观战者看
    pendingAnswer:
      mySeat !== null ? (runtimeState.pendingAnswer ?? null) : null,
    // 技能卡（仅本人可见自己的卡）：阶段/点数/once 计算可用性
    skills: (() => {
      if (mySeat === null || doc.flow.actionPointsPerRound <= 0) return [];
      const me = doc.characters.find(
        (c) =>
          c.id ===
          game.room.seats.find((s2) => s2.index === mySeat)?.characterId,
      );
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
    actionPointsLeft:
      mySeat !== null && doc.flow.actionPointsPerRound > 0
        ? (runtimeState.actionPoints?.[String(mySeat)] ?? 0)
        : 0,
    humanDeadline:
      mySeat !== null
        ? (runtimeState.humanDeadlines?.[String(mySeat)] ?? null)
        : null,
    // 推荐回复：轮到我发言时后台生成的建议短句
    suggestions:
      mySeat !== null ? (runtimeState.suggestions?.[String(mySeat)] ?? []) : [],
    // 向我开过私信窗口的 AI 座位列表（可回复）
    openWhispers:
      mySeat !== null
        ? Object.entries(runtimeState.privateChat ?? {})
            .filter(
              ([key, count]) =>
                Number(count) > 0 && Number(key.split("-")[1]) === mySeat,
            )
            .map(([key]) => Number(key.split("-")[0]))
        : [],
  };
}
