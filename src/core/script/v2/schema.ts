import { z } from "zod";

/**
 * 剧本文档 V2：语义数据契约。
 *
 * 文本叶子只承载内容，不承载 Markdown、HTML 或 CSS；段落、列表、引文、
 * 时间线和对象关系由数据结构表达，具体视觉样式由前端统一决定。
 */

const ID_RE = /^[a-z][a-z0-9_]*$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const idSchema = z.string().regex(ID_RE, "id 只能使用小写字母、数字和下划线，且必须以字母开头");
const leafText = z
  .string()
  .trim()
  .min(1, "文本不能为空")
  .refine((value) => !/[\r\n]/.test(value), "文本叶不能包含换行，请拆成多个内容块");

export const narrativeBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: leafText }).strict(),
  z
    .object({
      type: z.literal("list"),
      style: z.enum(["ordered", "unordered"]),
      items: z.array(leafText).min(1, "列表至少需要一个条目"),
    })
    .strict(),
  z
    .object({ type: z.literal("quote"), text: leafText, attribution: leafText.optional() })
    .strict(),
]);

export const narrativeSchema = z.array(narrativeBlockSchema).min(1, "至少需要一个内容块");
const optionalNarrativeSchema = z.array(narrativeBlockSchema).default([]);

const timePointSchema = z
  .object({
    dayOffset: z.number().int().default(0),
    time: z.string().regex(TIME_RE, "时间必须是 HH:mm"),
  })
  .strict();

export const timelineTimeSchema = z
  .object({
    display: leafText,
    precision: z.enum(["exact", "approximate", "range", "relative"]).default("exact"),
    start: timePointSchema.optional(),
    end: timePointSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.precision !== "relative" && !value.start) {
      ctx.addIssue({ code: "custom", path: ["start"], message: "非相对时间必须提供可排序的 start" });
    }
    if (value.precision === "range" && !value.end) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "range 时间必须提供 end" });
    }
  });

const relationRefSchema = z
  .object({ characterId: idSchema, label: leafText })
  .strict();

const timelineEntrySchema = z
  .object({
    id: idSchema,
    time: timelineTimeSchema,
    title: leafText,
    content: narrativeSchema,
    locationId: idSchema.optional(),
    characterIds: z.array(idSchema).default([]),
    clueIds: z.array(idSchema).default([]),
    truthEventId: idSchema.optional(),
  })
  .strict();

const secretSchema = z
  .object({
    id: idSchema,
    title: leafText,
    content: narrativeSchema,
    /** never=绝不披露；conditional=满足 condition 才可披露；must_share=必须在合适时机主动披露 */
    disclosure: z.enum(["never", "conditional", "must_share"]).default("never"),
    condition: leafText.optional(),
    /** 可由引擎确定判断的触发器；多个条件全部满足。自然语言 condition 仍由作者/主持判断。 */
    trigger: z.object({
      round: z.number().int().min(1).optional(),
      actId: idSchema.optional(),
      publicClueIds: z.array(idSchema).default([]),
    }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.disclosure === "conditional" && !value.condition) {
      ctx.addIssue({ code: "custom", path: ["condition"], message: "conditional 秘密必须说明披露条件" });
    }
  });

const objectiveSchema = z
  .object({
    id: idSchema,
    title: leafText,
    content: narrativeSchema,
    priority: z.enum(["primary", "secondary"]).default("primary"),
  })
  .strict();

const knowledgeSchema = z
  .object({
    id: idSchema,
    title: leafText,
    content: narrativeSchema,
    /** 情报性质：fact=亲见/持有，claim=听来的传闻，inference=自己的推断 */
    kind: z.enum(["fact", "claim", "inference"]).default("fact"),
    source: z.enum(["witnessed", "heard", "possessed", "inferred", "other"]),
    time: timelineTimeSchema.optional(),
    relatedCharacterIds: z.array(idSchema).default([]),
    relatedClueIds: z.array(idSchema).default([]),
  })
  .strict();

const personaSchema = z
  .object({
    traits: z.array(leafText).default([]),
    speechStyle: leafText,
    habits: z.array(leafText).default([]),
    taboos: z.array(leafText).default([]),
  })
  .strict();

const publicProfileSchema = z
  .object({
    identity: leafText.optional(),
    bio: narrativeSchema,
    relationships: z.array(relationRefSchema).default([]),
  })
  .strict();

const privateRelationshipSchema = z
  .object({ characterId: idSchema, label: leafText, notes: optionalNarrativeSchema })
  .strict();

/** 幕：分幕读本。roundStart = 该幕从第几轮搜证开始解锁（含当轮搜证与讨论）。 */
const actSchema = z
  .object({
    id: idSchema,
    title: leafText,
    brief: optionalNarrativeSchema,
    roundStart: z.number().int().min(1),
  })
  .strict();

/** 角色在某一幕解锁的增量内容（新知识/新目标），进入该幕时对 AI 生效。 */
const stageSchema = z
  .object({
    actId: idSchema,
    knowledge: z.array(knowledgeSchema).default([]),
    objectives: z.array(objectiveSchema).default([]),
  })
  .strict();

/** 技能卡：讨论/搜证阶段消耗行动点发动；v1 仅 verify（质询）效果，预留扩展 */
const skillSchema = z
  .object({
    id: idSchema,
    name: leafText,
    description: leafText,
    cost: z.number().int().min(1).max(3).default(1),
    phase: z.enum(["SEARCH", "DISCUSSION"]).default("DISCUSSION"),
    effect: z.enum(["verify"]).default("verify"),
    once: z.boolean().default(true),
  })
  .strict();

/** 真凶可使用、且已有事实依据的辩解抓手。 */
const defenseHookSchema = z
  .object({
    id: idSchema,
    claim: leafText,
    basis: leafText,
    brokenByPublicClueIds: z.array(idSchema).min(1).optional(),
    brokenWhen: z.object({
      allPublicClueIds: z.array(idSchema).min(1).optional(),
      anyPublicClueIds: z.array(idSchema).min(1).optional(),
    }).strict().optional(),
  })
  .strict();

const privateCardSchema = z
  .object({
    backstory: narrativeSchema,
    secrets: z.array(secretSchema).min(1, "每个角色至少需要一个秘密"),
    objectives: z.array(objectiveSchema).min(1, "每个角色至少需要一个目标"),
    timeline: z.array(timelineEntrySchema).min(1, "每个角色至少需要一个时间线事件"),
    knowledge: z.array(knowledgeSchema).default([]),
    relationships: z.array(privateRelationshipSchema).default([]),
    persona: personaSchema,
    isCulprit: z.boolean().default(false),
    /** 不在场证明：可在必要时主动陈述（通常与 timeline 一致，独立成字段便于审讯对线） */
    alibi: optionalNarrativeSchema,
    /** AI 红线：无论被怎么逼问都绝不能说破/做出来的事 */
    violation: z.array(leafText).default([]),
    /** 说谎时的小动作（演技抓手，多用于凶手） */
    tells: z.array(leafText).default([]),
    /** 可核验的辩解；旧剧本为空，通常只为真凶配置。 */
    defenseHooks: z.array(defenseHookSchema).default([]),
    /** 分幕增量：进入对应幕后追加的知识/目标 */
    stages: z.array(stageSchema).default([]),
    /** 技能卡：消耗行动点发动（flow.actionPointsPerRound > 0 才启用） */
    skills: z.array(skillSchema).default([]),
  })
  .strict();

export const characterV2Schema = z
  .object({
    id: idSchema,
    name: leafText,
    gender: leafText.optional(),
    age: z.number().int().min(1).max(120).optional(),
    publicProfile: publicProfileSchema,
    privateCard: privateCardSchema,
  })
  .strict();

export const locationV2Schema = z
  .object({
    id: idSchema,
    name: leafText,
    description: optionalNarrativeSchema,
    /** 房间主人：默认本人禁搜自己的房间（行业硬规则） */
    ownerCharacterId: idSchema.optional(),
  })
  .strict();

export const clueV2Schema = z
  .object({
    id: idSchema,
    locationId: idSchema,
    name: leafText,
    category: z.enum(["object", "document", "testimony", "trace", "medical", "digital", "other"]),
    content: narrativeSchema,
    policy: z.enum(["auto_public", "manual_public", "keep_private"]).default("manual_public"),
    relatedCharacterIds: z.array(idSchema).default([]),
    relatedTruthEventIds: z.array(idSchema).default([]),
    /** 禁搜：这些角色永远搜不到这条线索（搜证权限） */
    forbiddenCharacterIds: z.array(idSchema).default([]),
    /** 发放计划：不写则任何轮次可被随机搜到；写了则按轮次/前置公开线索过滤 */
    release: z
      .object({
        round: z.number().int().min(1).optional(),
        afterCluePublicIds: z.array(idSchema).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

const methodStepSchema = z
  .object({ id: idSchema, title: leafText, content: narrativeSchema, clueIds: z.array(idSchema).default([]) })
  .strict();

const evidenceChainSchema = z
  .object({ id: idSchema, clueIds: z.array(idSchema).min(1), conclusion: leafText })
  .strict();

const redHerringSchema = z
  .object({ id: idSchema, clueIds: z.array(idSchema).default([]), explanation: narrativeSchema })
  .strict();

const truthTimelineEntrySchema = timelineEntrySchema.omit({ truthEventId: true }).extend({ participantIds: z.array(idSchema).default([]) }).strict();

export const truthV2Schema = z
  .object({
    culpritId: idSchema,
    motive: optionalNarrativeSchema,
    method: z
      .object({ summary: narrativeSchema, steps: z.array(methodStepSchema).min(1) })
      .strict(),
    timeline: z.array(truthTimelineEntrySchema).min(1),
    keyEvidenceIds: z.array(idSchema).default([]),
    evidenceChain: z.array(evidenceChainSchema).default([]),
    redHerrings: z.array(redHerringSchema).default([]),
    supplemental: optionalNarrativeSchema,
    reveal: narrativeSchema,
  })
  .strict();

export const flowV2Schema = z
  .object({
    interactionBeats: z.array(z.object({
      id: idSchema,
      round: z.number().int().min(1),
      timing: z.literal("after_discussion"),
      characterId: idSchema,
      prompt: leafText,
      choices: z.array(z.object({ id: idSchema, label: leafText, recap: leafText }).strict()).min(2).max(6),
      defaultChoiceId: idSchema,
      visibility: z.enum(["public", "private"]),
    }).strict()).optional(),
    selfIntroRounds: z.number().int().min(1).max(3).default(1),
    searchRounds: z.number().int().min(1).max(4).default(2),
    discussionRounds: z.number().int().min(1).max(4).default(2),
    allowPrivateChat: z.boolean().default(false),
    privateChatMessageLimit: z.number().int().min(2).max(6).default(3),
    /** 讨论阶段允许把未公开线索卡私下面交给其他座位 */
    allowClueTransfer: z.boolean().default(false),
    /** 每轮行动点（0 = 技能系统关闭） */
    actionPointsPerRound: z.number().int().min(0).max(3).default(0),
    /** 结局模式：culprit=指凶（现状）；hybrid=指凶+答题；choice=纯答题（还原本/情感本） */
    voteMode: z.enum(["culprit", "hybrid", "choice"]).default("culprit"),
    /**
     * 分幕：roundStart 那一轮搜证开始时解锁角色 stages。
     * acts[].brief 是主持材料（DM 面板 + AI 主持上下文），不广播给玩家。
     */
    acts: z.array(actSchema).default([]),
  })
  .strict();

const outcomeSchema = z
  .object({
    result: z.enum(["culprit_caught", "culprit_escaped"]),
    title: leafText,
    content: narrativeSchema,
  })
  .strict();

/** 复盘答题选项（v1 单选；多选留扩展位） */
const quizOptionSchema = z
  .object({ id: idSchema, label: leafText })
  .strict();

/** 复盘答题：voteMode 为 hybrid/choice 时全场作答，结果进复盘 */
const quizQuestionSchema = z
  .object({
    id: idSchema,
    prompt: leafText,
    options: z.array(quizOptionSchema).min(2).max(6),
    correctOptionId: idSchema,
    weight: z.number().int().min(1).max(3).default(1),
  })
  .strict();

const PHASE_KEY = z.enum(["READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE"]);

/** DM 手册数据化：分阶段主持人提示 + 扶车指南（卡关应急） */
const hostGuideSchema = z
  .object({
    perPhase: z.array(z.object({ phase: PHASE_KEY, notes: leafText }).strict()).default([]),
    stallBreakers: z.array(z.object({ condition: leafText, hint: leafText }).strict()).default([]),
    /** 到截止搜证轮仍未公开时，由主持人自动补发的公共材料。 */
    guaranteedPublicClues: z.array(z.object({ clueId: idSchema, deadlineRound: z.number().int().min(1) }).strict()).default([]),
  })
  .strict();

export const scriptDocV2Schema = z
  .object({
    version: z.literal(2),
    meta: z
      .object({
        title: leafText,
        minPlayers: z.number().int().min(3).max(8),
        maxPlayers: z.number().int().min(3).max(8),
        durationMin: z.number().int().min(15).max(600),
        difficulty: z.enum(["新手", "进阶", "硬核"]),
        tags: z.array(leafText).default([]),
        intro: leafText,
      })
      .strict(),
    background: narrativeSchema,
    characters: z.array(characterV2Schema).min(3),
    locations: z.array(locationV2Schema).min(2),
    clues: z.array(clueV2Schema).min(3),
    truth: truthV2Schema,
    flow: flowV2Schema,
    ending: z
      .object({
        /** culprit 两结局；choice 模式下也保留，escaped 文案位承载「复盘总结」语义 */
        outcomes: z.array(outcomeSchema).length(2),
        /** 复盘答题（空 = 无答题）；culprit 模式忽略 */
        quiz: z.array(quizQuestionSchema).default([]),
      })
      .strict(),
    hostGuide: hostGuideSchema.optional(),
  })
  .strict();

export type NarrativeBlock = z.infer<typeof narrativeBlockSchema>;
export type Narrative = z.infer<typeof narrativeSchema>;
export type TimelineTime = z.infer<typeof timelineTimeSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type CharacterV2 = z.infer<typeof characterV2Schema>;
export type PrivateCardV2 = z.infer<typeof privateCardSchema>;
export type KnowledgeV2 = z.infer<typeof knowledgeSchema>;
export type StageV2 = z.infer<typeof stageSchema>;
export type SkillV2 = z.infer<typeof skillSchema>;
export type DefenseHookV2 = z.infer<typeof defenseHookSchema>;
export type QuizQuestionV2 = z.infer<typeof quizQuestionSchema>;
export type ActV2 = z.infer<typeof actSchema>;
export type HostGuideV2 = z.infer<typeof hostGuideSchema>;
export type LocationV2 = z.infer<typeof locationV2Schema>;
export type ClueV2 = z.infer<typeof clueV2Schema>;
export type TruthV2 = z.infer<typeof truthV2Schema>;
export type ScriptDocV2 = z.infer<typeof scriptDocV2Schema>;
export type ScriptDocV2Input = z.input<typeof scriptDocV2Schema>;

export function parseScriptDocV2(input: unknown): ScriptDocV2 {
  return scriptDocV2Schema.parse(input);
}

/** 公开切片：只返回固定的公开容器，不依赖调用方手工挑字段。 */
export function publicScriptViewV2(doc: ScriptDocV2) {
  return {
    version: doc.version,
    meta: doc.meta,
    background: doc.background,
    characters: doc.characters.map((c) => ({ id: c.id, name: c.name, gender: c.gender, age: c.age, publicProfile: c.publicProfile })),
    locations: doc.locations,
    clueCount: doc.clues.length,
    flow: { ...doc.flow, interactionBeats: doc.flow.interactionBeats?.filter((beat) => beat.visibility === "public") },
  };
}

export type PublicScriptViewV2 = ReturnType<typeof publicScriptViewV2>;
