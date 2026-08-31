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
  for (const [index, chain] of doc.truth.evidenceChain.entries()) checkRefs(issues, chain.clueIds, clueIds, `truth.evidenceChain.${index}.clueIds`);
  for (const [index, herring] of doc.truth.redHerrings.entries()) checkRefs(issues, herring.clueIds, clueIds, `truth.redHerrings.${index}.clueIds`);

  const results = new Set(doc.ending.outcomes.map((outcome) => outcome.result));
  for (const result of ["culprit_caught", "culprit_escaped"] as const) {
    if (!results.has(result)) issue(issues, "error", "ending.outcomes", `缺少结局: ${result}`);
  }
  if (doc.ending.outcomes.length !== results.size) issue(issues, "error", "ending.outcomes", "每种结局只能定义一次");

  return issues;
}

export function isScriptV2Playable(doc: ScriptDocV2) {
  const errors = validateScriptV2(doc).filter((entry) => entry.level === "error");
  return { ok: errors.length === 0, errors };
}
