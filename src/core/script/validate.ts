import type { ScriptDoc } from "./schema";

export interface ScriptIssue {
  level: "error" | "warning";
  message: string;
}

/**
 * 剧本逻辑校验器：结构由 Zod 保证，这里校验"剧本能不能开一局好游戏"。
 * error = 必须修复否则无法开局；warning = 影响体验的提示。
 */
export function validateScript(doc: ScriptDoc): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const charIds = doc.characters.map((c) => c.id);
  const dupChar = charIds.filter((id, i) => charIds.indexOf(id) !== i);
  if (dupChar.length) issues.push({ level: "error", message: `角色 id 重复: ${[...new Set(dupChar)].join(", ")}` });

  const clueIds = doc.clues.map((c) => c.id);
  const dupClue = clueIds.filter((id, i) => clueIds.indexOf(id) !== i);
  if (dupClue.length) issues.push({ level: "error", message: `线索 id 重复: ${[...new Set(dupClue)].join(", ")}` });

  if (doc.meta.minPlayers > doc.meta.maxPlayers)
    issues.push({ level: "error", message: "minPlayers 不能大于 maxPlayers" });

  if (doc.characters.length < doc.meta.minPlayers || doc.characters.length > doc.meta.maxPlayers)
    issues.push({
      level: "error",
      message: `角色数量(${doc.characters.length}) 必须在 ${doc.meta.minPlayers}~${doc.meta.maxPlayers} 人之间`,
    });

  // 真凶必须存在且标记一致
  const culprit = doc.characters.find((c) => c.id === doc.truth.culprit);
  if (!culprit) {
    issues.push({ level: "error", message: `truth.culprit "${doc.truth.culprit}" 不存在于角色列表` });
  } else if (!culprit.card.isCulprit) {
    issues.push({ level: "error", message: `角色 ${culprit.name} 的 card.isCulprit 与 truth.culprit 不一致` });
  }

  const culpritCount = doc.characters.filter((c) => c.card.isCulprit).length;
  if (culpritCount > 1) issues.push({ level: "error", message: "本格剧本只允许 1 名真凶（isCulprit 标记了多名）" });

  // 每个角色的私卡完整性
  for (const c of doc.characters) {
    if (!c.card.secret) issues.push({ level: "error", message: `角色 ${c.name} 缺少秘密(secret)` });
    if (!c.card.goal) issues.push({ level: "error", message: `角色 ${c.name} 缺少目标(goal)` });
    if (!c.card.timeline) issues.push({ level: "warning", message: `角色 ${c.name} 缺少个人时间线，AI 扮演质量会下降` });
    if (!c.card.knowledge.length)
      issues.push({ level: "warning", message: `角色 ${c.name} 没有任何已知情报(knowledge)` });
    if (c.card.isCulprit && c.card.goal.length < 10)
      issues.push({ level: "warning", message: `凶手 ${c.name} 的目标过于简短，隐瞒策略可能不可靠` });
  }

  // 线索地点合法性
  const locationSet = new Set(doc.locations);
  for (const clue of doc.clues) {
    if (!locationSet.has(clue.location))
      issues.push({ level: "error", message: `线索「${clue.name}」的地点 "${clue.location}" 不在 locations 中` });
  }
  for (const loc of doc.locations) {
    const count = doc.clues.filter((c) => c.location === loc).length;
    if (count === 0) issues.push({ level: "warning", message: `搜证地点「${loc}」没有任何线索卡` });
  }

  // 关键证据应能在线索中找到对应物（按名称包含匹配的弱校验）
  for (const key of doc.truth.keyEvidence) {
    const found = doc.clues.some((c) => c.name.includes(key) || key.includes(c.name) || c.content.includes(key));
    if (!found) issues.push({ level: "warning", message: `关键证据「${key}」没有对应的线索卡，破案链可能断裂` });
  }

  // 自动公开线索不宜过多（否则信息差消失）
  const autoPublic = doc.clues.filter((c) => c.policy === "auto_public").length;
  if (autoPublic > doc.clues.length / 3)
    issues.push({ level: "warning", message: `auto_public 线索占比过高(${autoPublic}/${doc.clues.length})，信息差不足` });

  // 私聊开启时至少 4 人才有意义
  if (doc.flow.allowPrivateChat && doc.meta.maxPlayers < 4)
    issues.push({ level: "warning", message: "少于 4 人的剧本开启私聊意义有限" });

  return issues;
}

export function isScriptPlayable(doc: ScriptDoc): { ok: boolean; errors: string[] } {
  const errors = validateScript(doc).filter((i) => i.level === "error").map((i) => i.message);
  return { ok: errors.length === 0, errors };
}
