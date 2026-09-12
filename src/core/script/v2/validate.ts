import type { ScriptDocV2, TimelineTime } from "./schema";

export interface ScriptV2Issue {
  level: "error" | "warning";
  path: string;
  message: string;
}

const issue = (issues: ScriptV2Issue[], level: ScriptV2Issue["level"], path: string, message: string) =>
  issues.push({ level, path, message });

function checkUniqueIds(issues: ScriptV2Issue[], values: Array<{ id: string }>, path: string) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) issue(issues, "error", `${path}.${index}.id`, `重复 id: ${value.id}`);
    seen.add(value.id);
  }
}

function checkRefs(issues: ScriptV2Issue[], refs: string[], valid: Set<string>, path: string) {
  for (const [index, ref] of refs.entries()) {
    if (!valid.has(ref)) issue(issues, "error", `${path}.${index}`, `引用不存在: ${ref}`);
  }
}

function minuteValue(point: { dayOffset: number; time: string }) {
  const [hour, minute] = point.time.split(":").map(Number);
  return point.dayOffset * 24 * 60 + hour * 60 + minute;
}

function checkTimelineOrder(issues: ScriptV2Issue[], entries: Array<{ time: TimelineTime }>, path: string) {
  let previous: number | null = null;
  for (const [index, entry] of entries.entries()) {
    if (!entry.time.start) {
      if (entry.time.precision !== "relative") issue(issues, "warning", `${path}.${index}.time`, "缺少可排序的 start，前端只能按数组顺序展示");
      continue;
    }
    const current = minuteValue(entry.time.start);
    if (previous !== null && current < previous) {
      issue(issues, "warning", `${path}.${index}.time`, "时间早于上一事件；数组顺序仍作为权威顺序");
    }
    if (entry.time.end && minuteValue(entry.time.end) < current) {
      issue(issues, "error", `${path}.${index}.time.end`, "结束时间早于开始时间");
    }
    previous = current;
  }
}

type TimelineEntryLike = {
  id: string;
  time: TimelineTime;
  locationId?: string;
  characterIds: string[];
  clueIds: string[];
  truthEventId?: string;
};

function checkTimelineEntries(issues: ScriptV2Issue[], entries: TimelineEntryLike[], path: string, locationIds: Set<string>, clueIds: Set<string>, characterIds: Set<string>, truthEventIds?: Set<string>) {
  checkUniqueIds(issues, entries, path);
  checkTimelineOrder(issues, entries, path);
  for (const [index, entry] of entries.entries()) {
    if (entry.locationId && !locationIds.has(entry.locationId)) issue(issues, "error", `${path}.${index}.locationId`, `地点不存在: ${entry.locationId}`);
    checkRefs(issues, entry.clueIds, clueIds, `${path}.${index}.clueIds`);
    checkRefs(issues, entry.characterIds, characterIds, `${path}.${index}.characterIds`);
    if (entry.truthEventId && truthEventIds && !truthEventIds.has(entry.truthEventId)) {
      issue(issues, "error", `${path}.${index}.truthEventId`, `真相时间线事件不存在: ${entry.truthEventId}`);
    }
  }
}

export function validateScriptV2(doc: ScriptDocV2): ScriptV2Issue[] {
  const issues: ScriptV2Issue[] = [];
  const characterIds = new Set(doc.characters.map((c) => c.id));
  const locationIds = new Set(doc.locations.map((l) => l.id));
  const clueIds = new Set(doc.clues.map((c) => c.id));
  const truthEventIds = new Set(doc.truth.timeline.map((e) => e.id));

  checkUniqueIds(issues, doc.characters, "characters");
  checkUniqueIds(issues, doc.locations, "locations");
  checkUniqueIds(issues, doc.clues, "clues");

  if (doc.meta.minPlayers > doc.meta.maxPlayers) issue(issues, "error", "meta", "minPlayers 不能大于 maxPlayers");
  if (doc.characters.length < doc.meta.minPlayers || doc.characters.length > doc.meta.maxPlayers) {
    issue(issues, "error", "characters", `角色数量(${doc.characters.length}) 不在 ${doc.meta.minPlayers}~${doc.meta.maxPlayers} 范围内`);
  }

  const culprit = doc.characters.filter((c) => c.privateCard.isCulprit);
  if (culprit.length !== 1) issue(issues, "error", "characters", `真凶标记了 ${culprit.length} 人，必须恰好 1 人`);
  if (!characterIds.has(doc.truth.culpritId)) issue(issues, "error", "truth.culpritId", `角色不存在: ${doc.truth.culpritId}`);
  if (culprit.length === 1 && culprit[0].id !== doc.truth.culpritId) {
    issue(issues, "error", "truth.culpritId", "truth.culpritId 与角色的 isCulprit 标记不一致");
  }

  for (const [index, character] of doc.characters.entries()) {
    checkRefs(issues, character.publicProfile.relationships.map((r) => r.characterId), characterIds, `characters.${index}.publicProfile.relationships`);
    checkRefs(issues, character.privateCard.relationships.map((r) => r.characterId), characterIds, `characters.${index}.privateCard.relationships`);
    checkTimelineEntries(issues, character.privateCard.timeline, `characters.${index}.privateCard.timeline`, locationIds, clueIds, characterIds, truthEventIds);
    for (const [kIndex, item] of character.privateCard.knowledge.entries()) {
      checkRefs(issues, item.relatedCharacterIds, characterIds, `characters.${index}.privateCard.knowledge.${kIndex}.relatedCharacterIds`);
      checkRefs(issues, item.relatedClueIds, clueIds, `characters.${index}.privateCard.knowledge.${kIndex}.relatedClueIds`);
    }
  }

  for (const [index, clue] of doc.clues.entries()) {
    if (!locationIds.has(clue.locationId)) issue(issues, "error", `clues.${index}.locationId`, `地点不存在: ${clue.locationId}`);
    checkRefs(issues, clue.relatedCharacterIds, characterIds, `clues.${index}.relatedCharacterIds`);
    checkRefs(issues, clue.relatedTruthEventIds, truthEventIds, `clues.${index}.relatedTruthEventIds`);
  }

  checkTimelineEntries(issues, doc.truth.timeline, "truth.timeline", locationIds, clueIds, characterIds);
  for (const [index, event] of doc.truth.timeline.entries()) {
    checkRefs(issues, event.participantIds, characterIds, `truth.timeline.${index}.participantIds`);
  }
  checkRefs(issues, doc.truth.keyEvidenceIds, clueIds, "truth.keyEvidenceIds");
  if (doc.truth.evidenceChain.length === 0) issue(issues, "warning", "truth.evidenceChain", "尚未整理出证据链");
  if (doc.truth.motive.length === 0) issue(issues, "warning", "truth.motive", "尚未提供独立动机段落");
  for (const [index, step] of doc.truth.method.steps.entries()) checkRefs(issues, step.clueIds, clueIds, `truth.method.steps.${index}.clueIds`);
  for (const [index, chain] of doc.truth.evidenceChain.entries()) {
    checkRefs(issues, chain.clueIds, clueIds, `truth.evidenceChain.${index}.clueIds`);
    // 行业共识：单条线索不锁凶，证据链至少两条线索交叉
    if (chain.clueIds.length < 2) {
      issue(issues, "warning", `truth.evidenceChain.${index}.clueIds`, "证据链只有一条线索支撑，容易单线索锁凶（建议人证+物证交叉）");
    }
  }
  for (const [index, herring] of doc.truth.redHerrings.entries()) checkRefs(issues, herring.clueIds, clueIds, `truth.redHerrings.${index}.clueIds`);

  // R1 线索池预算：全场最多发现 人数×搜证轮数 张卡，超出必有线索永不出现（按实际角色数计）
  const maxDiscoverable = doc.characters.length * doc.flow.searchRounds;
  if (doc.clues.length > maxDiscoverable) {
    issue(issues, "error", "clues", `线索数(${doc.clues.length})超过可发现上限(${doc.characters.length}人×${doc.flow.searchRounds}轮=${maxDiscoverable})，必有线索永不出现`);
  }

  // S1 残留检测：无辜者卡片任何通道不得出现真凶姓名（knowledge/秘密/背景/目标/时间线标题/不在场证明）
  const culpritCharacter = doc.characters.find((c) => c.id === doc.truth.culpritId);
  if (culpritCharacter) {
    const name = culpritCharacter.name;
    for (const [index, character] of doc.characters.entries()) {
      if (character.id === culpritCharacter.id) continue;
      const card = character.privateCard;
      const channels: Array<[string, string]> = [
        ...card.knowledge.map((k, i) => [`knowledge.${i}`, `${k.title}${JSON.stringify(k.content)}`] as [string, string]),
        ...card.secrets.map((s, i) => [`secrets.${i}`, `${s.title}${JSON.stringify(s.content)}`] as [string, string]),
        ...card.objectives.map((o, i) => [`objectives.${i}`, `${o.title}${JSON.stringify(o.content)}`] as [string, string]),
        ...card.timeline.map((t, i) => [`timeline.${i}`, `${t.title}${JSON.stringify(t.content)}`] as [string, string]),
        ["backstory", JSON.stringify(card.backstory)],
        ["alibi", JSON.stringify(card.alibi)],
      ];
      for (const [channel, text] of channels) {
        if (text.includes(name)) {
          issue(issues, "warning", `characters.${index}.privateCard.${channel}.content`, `无辜角色卡片提及真凶姓名「${name}」，读卡即锁凶`);
        }
      }
    }
  }

  // 分幕校验：acts 唯一、roundStart 不超过搜证轮数；stages 必须指向已定义的 act
  const actIds = new Set(doc.flow.acts.map((a) => a.id));
  checkUniqueIds(issues, doc.flow.acts, "flow.acts");
  for (const [index, act] of doc.flow.acts.entries()) {
    if (act.roundStart > doc.flow.searchRounds) {
      issue(issues, "warning", `flow.acts.${index}.roundStart`, `幕「${act.title}」的 roundStart(${act.roundStart})超过搜证轮数(${doc.flow.searchRounds})，该幕永远不会解锁`);
    }
  }
  for (const [index, character] of doc.characters.entries()) {
    for (const [sIndex, stage] of character.privateCard.stages.entries()) {
      if (!actIds.has(stage.actId)) {
        issue(issues, "error", `characters.${index}.privateCard.stages.${sIndex}.actId`, `幕不存在: ${stage.actId}`);
      }
      checkRefs(issues, stage.knowledge.flatMap((k) => k.relatedClueIds), clueIds, `characters.${index}.privateCard.stages.${sIndex}.knowledge.relatedClueIds`);
    }
  }

  // 技能卡：id 唯一；消耗超过每轮行动点则永远无法使用；质询建议讨论阶段（搜证阶段没有当众作答回合）
  for (const [index, character] of doc.characters.entries()) {
    checkUniqueIds(issues, character.privateCard.skills, `characters.${index}.privateCard.skills`);
    for (const [sIndex, skill] of character.privateCard.skills.entries()) {
      if (skill.cost > doc.flow.actionPointsPerRound) {
        issue(issues, "warning", `characters.${index}.privateCard.skills.${sIndex}.cost`, `技能「${skill.name}」消耗(${skill.cost})超过每轮行动点(${doc.flow.actionPointsPerRound})，将永远无法使用`);
      }
      if (skill.effect === "verify" && skill.phase === "SEARCH") {
        issue(issues, "warning", `characters.${index}.privateCard.skills.${sIndex}.phase`, `质询技能「${skill.name}」建议设在讨论阶段（搜证阶段没有当众作答机制）`);
      }
    }
  }
  for (const [index, clue] of doc.clues.entries()) {
    checkRefs(issues, clue.forbiddenCharacterIds, characterIds, `clues.${index}.forbiddenCharacterIds`);
    if (clue.release) checkRefs(issues, clue.release.afterCluePublicIds, clueIds, `clues.${index}.release.afterCluePublicIds`);
  }
  for (const [index, location] of doc.locations.entries()) {
    if (location.ownerCharacterId && !characterIds.has(location.ownerCharacterId)) {
      issue(issues, "error", `locations.${index}.ownerCharacterId`, `角色不存在: ${location.ownerCharacterId}`);
    }
  }

  const results = new Set(doc.ending.outcomes.map((outcome) => outcome.result));
  for (const result of ["culprit_caught", "culprit_escaped"] as const) {
    if (!results.has(result)) issue(issues, "error", "ending.outcomes", `缺少结局: ${result}`);
  }
  if (doc.ending.outcomes.length !== results.size) issue(issues, "error", "ending.outcomes", "每种结局只能定义一次");

  return issues;
}

export function isScriptPlayable(doc: ScriptDocV2): { ok: boolean; errors: string[] } {
  const errors = validateScriptV2(doc)
    .filter((entry) => entry.level === "error")
    .map((entry) => entry.message);
  return { ok: errors.length === 0, errors };
}

export function isScriptV2Playable(doc: ScriptDocV2) {
  const errors = validateScriptV2(doc).filter((entry) => entry.level === "error");
  return { ok: errors.length === 0, errors };
}
