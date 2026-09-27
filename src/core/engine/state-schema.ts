import { z } from "zod";
import type { GameState } from "./types";

/**
 * GameState 的运行时校验（S4.3）。
 *
 * 结构对齐 `types.ts` 的 `GameState`：这里只声明「当前形态」，历史形态先由
 * `state-migrate.ts` 补全，再交给本 schema 校验。
 * 所有对象都用 `.loose()`（zod v4 中 `.passthrough()` 的替代）：旧快照残留的
 * 冗余字段原样保留，不会因为多字段而校验失败。
 */

/** 与 types.ts 的 Phase 联合、PHASE_ORDER 保持同步 */
const PhaseSchema = z.enum(["LOBBY", "READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"]);

const SeatSchema = z.looseObject({
  index: z.number(),
  kind: z.enum(["human", "ai", "empty"]),
  characterId: z.string(),
  playerName: z.string(),
});

const VoteRecordSchema = z.looseObject({
  target: z.number(),
  reason: z.string().optional(),
  evidenceIds: z.array(z.string()).optional(),
});

const QuizResultSchema = z.looseObject({
  perSeat: z.record(z.string(), z.looseObject({ correct: z.number(), total: z.number(), score: z.number() })),
  perQuestion: z.array(
    z.looseObject({
      questionId: z.string(),
      counts: z.record(z.string(), z.number()),
      correctOptionId: z.string(),
    })
  ),
});

const ActionPlanSchema = z.looseObject({
  objectiveId: z.string().nullable(),
  targetSeat: z.number().nullable(),
  discloseClueIds: z.array(z.string()),
  holdClueIds: z.array(z.string()),
  focusEvidenceIds: z.array(z.string()).optional(),
  claimSummary: z.string().nullable().optional(),
  defenseHookId: z.string().nullable().optional(),
  nextAction: z.enum(["state", "ask", "defend", "probe", "exchange", "wait"]),
});

export const GameStateSchema = z.looseObject({
  stateVersion: z.number().int(),
  phase: PhaseSchema,
  round: z.number(),
  seats: z.array(SeatSchema),
  /** 键为线索 id */
  clueStates: z.record(z.string(), z.looseObject({ discoveredBy: z.number().nullable(), isPublic: z.boolean() })),
  /** TS 侧是 `Record<number, string[]>`，JSON 里键只能是字符串 */
  heldClues: z.record(z.number(), z.array(z.string())),
  readySeats: z.array(z.number()),
  readingPromptedSeats: z.array(z.number()).optional(),
  spokenSeats: z.array(z.number()),
  turnSeat: z.number().nullable(),
  votes: z.record(z.string(), VoteRecordSchema),
  /** 键为 `${from}-${to}` */
  privateChat: z.record(z.string(), z.number()),
  searchChoices: z.record(z.string(), z.string()),
  pendingPublish: z.record(z.string(), z.array(z.string())),
  searchDealtRound: z.number(),
  voteResult: z
    .looseObject({
      counts: z.record(z.string(), z.number()),
      culpritSeat: z.number(),
      caught: z.boolean(),
      tiedSeats: z.array(z.number()).optional(),
    })
    .nullable(),
  interjections: z.number(),
  questionsLeft: z.record(z.string(), z.number()),
  pendingAnswer: z
    .looseObject({
      questionId: z.string().optional(),
      fromSeat: z.number(),
      toSeat: z.number(),
      question: z.string(),
      evidenceIds: z.array(z.string()).optional(),
      forced: z.boolean().optional(),
    })
    .nullable(),
  actionPoints: z.record(z.string(), z.number()).optional(),
  /** 键为 `${seat}:${skillId}` */
  usedSkills: z.array(z.string()).optional(),
  quizAnswers: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  quizResult: QuizResultSchema.nullable().optional(),
  /** 键为 `${seat}:${secretId}` */
  unlockedSecrets: z.record(z.string(), z.boolean()).optional(),
  hostHandouts: z.record(z.string(), z.looseObject({ round: z.number(), reason: z.string() })).optional(),
  guaranteeDeferUntil: z.record(z.string(), z.number()).optional(),
  /** 键为提示在手册中的索引 */
  hostHints: z.record(z.string(), z.looseObject({ round: z.number(), condition: z.string(), hint: z.string() })).optional(),
  humanDeadlines: z.record(z.string(), z.number()).optional(),
  memory: z.looseObject({ anchorSeq: z.string(), summary: z.string() }).optional(),
  suggestions: z.record(z.string(), z.array(z.string())).optional(),
  actionPlans: z.record(z.string(), ActionPlanSchema).optional(),
  pendingInteraction: z.looseObject({ beatId: z.string(), seatIndex: z.number(), deadlineAt: z.number().optional() }).nullable().optional(),
  interactionChoices: z.record(z.string(), z.looseObject({ seatIndex: z.number(), choiceId: z.string(), round: z.number(), skipped: z.boolean().optional() })).optional(),
});

/** 校验通过即视为 `GameState`：schema 与 types.ts 同构，未知字段被原样保留。 */
export function parseGameState(value: unknown): GameState {
  return GameStateSchema.parse(value);
}
