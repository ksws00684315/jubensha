import type { ScriptDocV2 } from "./v2/schema";
import type { AuthorDesignPackage } from "./design";
import { computeLockMetric } from "./lock-metric";

export interface PlayabilityIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

const textOf = (blocks: Array<{ text?: string; items?: string[] }>): string =>
  blocks.map((block) => [block.text, ...(block.items ?? [])].filter(Boolean).join(" ")).join(" ");

/**
 * 不把 truth 注入读者输入的离线可玩性检查：验证每个座位的材料路径、
 * 角色行动空间、分幕投放和公共线索依赖。它回答“能不能玩”，不替作者
 * 判断故事是否精彩，也不宣称通过真人试演。
 */
export function auditScriptPlayability(doc: ScriptDocV2, design?: AuthorDesignPackage): PlayabilityIssue[] {
  const issues: PlayabilityIssue[] = [];
  const clueById = new Map(doc.clues.map((clue) => [clue.id, clue]));
  const actById = new Map(doc.flow.acts.map((act) => [act.id, act]));
  const maxRounds = doc.flow.searchRounds;
  const report = (level: PlayabilityIssue["level"], path: string, message: string) => issues.push({ level, path, message });

  if (!doc.flow.acts.length) report("warning", "flow.acts", "未配置分幕，无法向玩家明确说明阶段问题与新增知识");
  for (const [index, clue] of doc.clues.entries()) {
    const release = clue.release;
    if (release?.round !== undefined && release.round > maxRounds) report("error", `clues.${index}.release.round`, `释放轮次 ${release.round} 超过搜证轮数 ${maxRounds}`);
    for (const dep of release?.afterCluePublicIds ?? []) {
      const dependency = clueById.get(dep);
      if (!dependency) continue;
      if (dependency.release?.round !== undefined && release?.round !== undefined && dependency.release.round > release.round) {
        report("error", `clues.${index}.release.afterCluePublicIds`, `依赖线索 ${dep} 的释放轮次晚于当前线索`);
      }
    }
    if (!clue.locationId) report("error", `clues.${index}.locationId`, "线索缺少可搜证地点");
    if (clue.forbiddenCharacterIds.length >= doc.characters.length) report("error", `clues.${index}.forbiddenCharacterIds`, "所有角色都被禁止获取，材料不可达");
  }

  for (const [index, character] of doc.characters.entries()) {
    const card = character.privateCard;
    if (!card.objectives.length) report("error", `characters.${index}.privateCard.objectives`, "角色没有可执行目标");
    if (!card.timeline.length && !card.knowledge.length) report("warning", `characters.${index}.privateCard`, "角色没有时间线或额外情报，盲读时可能无事可做");
    for (const [secretIndex, secret] of card.secrets.entries()) {
      if (secret.disclosure === "conditional" && !secret.condition && !secret.trigger) report("error", `characters.${index}.privateCard.secrets.${secretIndex}`, "条件秘密缺少可判断触发条件");
      for (const clueId of secret.trigger?.publicClueIds ?? []) if (!clueById.has(clueId)) report("error", `characters.${index}.privateCard.secrets.${secretIndex}.trigger.publicClueIds`, `引用不存在的公开线索 ${clueId}`);
      if (secret.trigger?.actId && !actById.has(secret.trigger.actId)) report("error", `characters.${index}.privateCard.secrets.${secretIndex}.trigger.actId`, `引用不存在的幕 ${secret.trigger.actId}`);
    }
    for (const [stageIndex, stage] of (card.stages ?? []).entries()) if (!actById.has(stage.actId)) report("error", `characters.${index}.privateCard.stages.${stageIndex}.actId`, `引用不存在的幕 ${stage.actId}`);
  }

  for (const [index, act] of doc.flow.acts.entries()) {
    if (!doc.clues.some((clue) => clue.release?.round === act.roundStart || (!clue.release && act.roundStart === 1))) report("warning", `flow.acts.${index}`, `第 ${act.title} 没有明确对应的线索投放`);
  }

  const background = textOf(doc.background);
  for (const [index, clue] of doc.clues.entries()) {
    const clueText = textOf(clue.content);
    if (clueText.length >= 24 && background.includes(clueText)) report("warning", `clues.${index}.content`, "线索全文已在公开背景中重复，可能提前透支搜证价值");
  }

  for (const [index, evidenceId] of doc.truth.keyEvidenceIds.entries()) {
    const clue = clueById.get(evidenceId);
    if (!clue) continue;
    if (clue.forbiddenCharacterIds.length >= doc.characters.length) report("error", `truth.keyEvidenceIds.${index}`, `关键证据 ${evidenceId} 无任何获取路径`);
  }

  // 卡片文本口径：判词和抹名目击都是"作者替玩家把话说完了"，只报 warning 供改稿时清账
  const lock = computeLockMetric(doc);
  for (const clueId of lock.verdictClueIds) {
    const index = doc.clues.findIndex((clue) => clue.id === clueId);
    report("warning", `clues.${index}.content`, `「${doc.clues[index]?.name ?? clueId}」在卡片里替玩家下判词（能证明／不足以说明…），这类结论请写进 hostGuide 或 truth.evidenceChain`);
  }
  for (const hit of lock.blankedWitnesses) {
    const index = doc.characters.findIndex((character) => character.id === hit.characterId);
    report("warning", `characters.${index}.privateCard.${hit.section}`, `${hit.characterName} 的目击被写成"有人/那人"（${hit.excerpt}），玩家台上只能说空话；请点名并留出归因错的出口`);
  }

  if (design) {
    for (const [index, plan] of design.characterPlans.entries()) {
      if (!plan.objectives.length && !plan.interactionHooks.length) report("warning", `design.characterPlans.${index}`, `角色 ${plan.characterId} 没有设计目标或互动钩子`);
    }
    for (const [index, act] of design.acts.entries()) {
      if (!act.publicClueIds.length) report("warning", `design.acts.${index}.publicClueIds`, `设计幕 ${act.actId} 没有安排公共材料`);
      for (const clueId of act.publicClueIds) if (!clueById.has(clueId)) report("error", `design.acts.${index}.publicClueIds`, `引用不存在的线索 ${clueId}`);
    }
  }
  return issues;
}
