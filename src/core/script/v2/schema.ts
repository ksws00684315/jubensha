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
    disclosure: z.enum(["never", "conditional"]).default("never"),
    condition: leafText.optional(),
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
  .object({ id: idSchema, name: leafText, description: optionalNarrativeSchema })
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
    selfIntroRounds: z.number().int().min(1).max(3).default(1),
    searchRounds: z.number().int().min(1).max(4).default(2),
    discussionRounds: z.number().int().min(1).max(4).default(2),
    allowPrivateChat: z.boolean().default(false),
    privateChatMessageLimit: z.number().int().min(2).max(6).default(3),
  })
  .strict();

const outcomeSchema = z
  .object({
    result: z.enum(["culprit_caught", "culprit_escaped"]),
    title: leafText,
    content: narrativeSchema,
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
    ending: z.object({ outcomes: z.array(outcomeSchema).length(2) }).strict(),
  })
  .strict();

export type NarrativeBlock = z.infer<typeof narrativeBlockSchema>;
export type Narrative = z.infer<typeof narrativeSchema>;
export type TimelineTime = z.infer<typeof timelineTimeSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
export type CharacterV2 = z.infer<typeof characterV2Schema>;
export type PrivateCardV2 = z.infer<typeof privateCardSchema>;
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
    flow: doc.flow,
  };
}

export type PublicScriptViewV2 = ReturnType<typeof publicScriptViewV2>;
