import { createHash } from "node:crypto";
import { z } from "zod";
import type { ScriptDocV2 } from "./v2/schema";

const ref = z.string().min(1);

/**
 * 作者设计包不属于运行时 V2 正文：它承载事实账本、推论图、角色互动
 * 和审稿输入，允许内容团队在正文编译前反复修改。
 */
export const authorDesignPackageSchema = z.object({
  version: z.literal(1),
  experienceGoal: z.string().trim().min(1),
  targetDurationMin: z.number().int().min(15).max(600).optional(),
  facts: z.array(z.object({ id: ref, statement: z.string().trim().min(1), source: z.string().trim().min(1).optional() }).strict()).default([]),
  inferenceGraph: z.array(z.object({
    id: ref,
    premiseFactIds: z.array(ref).default([]),
    conclusion: z.string().trim().min(1),
    alternatives: z.array(z.string().trim().min(1)).default([]),
  }).strict()).default([]),
  characterPlans: z.array(z.object({
    characterId: ref,
    experienceGoal: z.string().trim().min(1).optional(),
    objectives: z.array(z.string().trim().min(1)).default([]),
    interactionHooks: z.array(z.string().trim().min(1)).default([]),
  }).strict()).default([]),
  acts: z.array(z.object({
    actId: ref,
    question: z.string().trim().min(1),
    newKnowledge: z.array(z.string().trim().min(1)).default([]),
    publicClueIds: z.array(ref).default([]),
  }).strict()).default([]),
  review: z.object({
    status: z.enum(["draft", "passed", "needs_revision"]).default("draft"),
    issues: z.array(z.object({ level: z.enum(["error", "warning"]), message: z.string().trim().min(1), path: z.string().optional() }).strict()).default([]),
    documentHash: z.string().optional(),
  }).strict().default({ status: "draft", issues: [] }),
}).strict();

export type AuthorDesignPackage = z.infer<typeof authorDesignPackageSchema>;

export function designPackageHash(pkg: AuthorDesignPackage): string {
  return createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
}

/** 检查设计包引用是否能落到当前正文，语义审稿仍由作者/模型完成。 */
export function validateAuthorDesignPackage(pkg: AuthorDesignPackage, doc?: ScriptDocV2): Array<{ level: "error" | "warning"; path: string; message: string }> {
  const issues: Array<{ level: "error" | "warning"; path: string; message: string }> = [];
  if (!doc) return issues;
  const characters = new Set(doc.characters.map((c) => c.id));
  const clues = new Set(doc.clues.map((c) => c.id));
  const acts = new Set(doc.flow.acts.map((a) => a.id));
  const facts = new Set(pkg.facts.map((f) => f.id));
  for (const [i, item] of pkg.inferenceGraph.entries()) {
    for (const factId of item.premiseFactIds) if (!facts.has(factId)) issues.push({ level: "error", path: `inferenceGraph.${i}.premiseFactIds`, message: `引用不存在的事实 ${factId}` });
  }
  for (const [i, item] of pkg.characterPlans.entries()) if (!characters.has(item.characterId)) issues.push({ level: "error", path: `characterPlans.${i}.characterId`, message: `引用不存在的角色 ${item.characterId}` });
  for (const [i, item] of pkg.acts.entries()) {
    if (!acts.has(item.actId)) issues.push({ level: "error", path: `acts.${i}.actId`, message: `引用不存在的幕 ${item.actId}` });
    for (const clueId of item.publicClueIds) if (!clues.has(clueId)) issues.push({ level: "error", path: `acts.${i}.publicClueIds`, message: `引用不存在的线索 ${clueId}` });
  }
  if (!pkg.facts.length) issues.push({ level: "warning", path: "facts", message: "设计包尚未建立事实账本" });
  if (!pkg.inferenceGraph.length) issues.push({ level: "warning", path: "inferenceGraph", message: "设计包尚未建立推论图" });
  return issues;
}
