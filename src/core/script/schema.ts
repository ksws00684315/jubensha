import { z } from "zod";

/**
 * 剧本文档 Schema —— 整个系统的核心数据契约。
 * 剧本管理（导入/AI生成）、游戏引擎（防火墙分级取数）都以此为准。
 * 约定：truth / characters[].card 仅服务端与 DM 可见，绝不进入普通玩家的上下文。
 */

export const DIFFICULTIES = ["新手", "进阶", "硬核"] as const;

export const cluePolicySchema = z.enum(["auto_public", "manual_public", "keep_private"]);

export const characterCardSchema = z.object({
  backstory: z.string().min(20, "角色背景过短"),
  secret: z.string().min(4, "每个角色必须有不可告人的秘密"),
  goal: z.string().min(4, "每个角色必须有本轮目标"),
  isCulprit: z.boolean().default(false),
  timeline: z.string().min(10, "缺少个人时间线"),
  knowledge: z.array(z.string()).default([]),
  persona: z.string().min(4, "缺少说话风格设定"),
});

export const characterSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_]+$/, "角色 id 只能是小写字母/数字/下划线"),
  name: z.string().min(1),
  gender: z.string().optional(),
  age: z.number().int().min(1).max(120).optional(),
  publicBio: z.string().min(4, "缺少公开简介"),
  card: characterCardSchema,
});

export const clueSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  location: z.string().min(1),
  name: z.string().min(1),
  content: z.string().min(4, "线索卡内容过短"),
  policy: cluePolicySchema.default("manual_public"),
});

export const truthSchema = z.object({
  culprit: z.string().min(1),
  method: z.string().min(4, "缺少作案手法"),
  fullTimeline: z.string().min(20, "缺少完整时间线"),
  keyEvidence: z.array(z.string()).default([]),
  reveal: z.string().min(20, "缺少复盘底稿"),
});

export const flowSchema = z.object({
  selfIntroRounds: z.number().int().min(1).max(3).default(1),
  searchRounds: z.number().int().min(1).max(4).default(2),
  discussionRounds: z.number().int().min(1).max(4).default(2),
  allowPrivateChat: z.boolean().default(false),
  privateChatMessageLimit: z.number().int().min(2).max(6).default(3),
});

/** flow 的默认值（zod v4 的 .default 需要完整输出形态） */
const FLOW_DEFAULTS = { selfIntroRounds: 1, searchRounds: 2, discussionRounds: 2, allowPrivateChat: false, privateChatMessageLimit: 3 };

export const scriptDocSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    title: z.string().min(1),
    minPlayers: z.number().int().min(3).max(8),
    maxPlayers: z.number().int().min(3).max(8),
    durationMin: z.number().int().min(15).max(600),
    difficulty: z.enum(DIFFICULTIES),
    tags: z.array(z.string()).default([]),
    intro: z.string().min(4),
  }),
  background: z.string().min(20, "公开背景过短"),
  characters: z.array(characterSchema).min(3, "至少 3 个角色"),
  locations: z.array(z.string().min(1)).min(2, "至少 2 个搜证地点"),
  clues: z.array(clueSchema).min(3, "至少 3 张线索卡"),
  truth: truthSchema,
  flow: flowSchema.default(FLOW_DEFAULTS),
  ending: z.object({
    winText: z.string().min(4, "缺少胜负说明"),
  }),
});

export type CharacterCard = z.infer<typeof characterCardSchema>;
export type Character = z.infer<typeof characterSchema>;
export type Clue = z.infer<typeof clueSchema>;
export type Truth = z.infer<typeof truthSchema>;
export type ScriptFlow = z.infer<typeof flowSchema>;
export type ScriptDoc = z.infer<typeof scriptDocSchema>;
/** 导入/生成时的输入形态（default 字段可缺省） */
export type ScriptDocInput = z.input<typeof scriptDocSchema>;

export function parseScriptDoc(input: unknown): ScriptDoc {
  return scriptDocSchema.parse(input);
}

/** 对玩家/列表可见的公开切片：不含真相、私卡、线索正文。 */
export function publicScriptView(doc: ScriptDoc) {
  return {
    meta: doc.meta,
    background: doc.background,
    locations: doc.locations,
    characters: doc.characters.map((c) => ({
      id: c.id,
      name: c.name,
      gender: c.gender,
      age: c.age,
      publicBio: c.publicBio,
    })),
    clueCount: doc.clues.length,
    flow: doc.flow,
  };
}

export type PublicScriptView = ReturnType<typeof publicScriptView>;
