import type { ScriptDoc } from "../schema";
import { parseScriptDocV2, type Narrative, type ScriptDocV2, type TimelineTime } from "./schema";

export interface MigrationWarning {
  path: string;
  message: string;
}

export interface MigrationResult {
  doc: ScriptDocV2;
  warnings: MigrationWarning[];
}

const timeMarker = /(?<![\d\-–—至])(约|次日|翌日|凌晨)?((?:[01]\d|2[0-3]):[0-5]\d)(?:\s*[-–—至]\s*((?:[01]\d|2[0-3]):[0-5]\d))?/;
const splitMarker = /(?<![\d\-–—至])(?=(?:约|次日|翌日|凌晨)?(?:[01]\d|2[0-3]):[0-5]\d)/g;

function blocks(text: string): Narrative {
  return text
    .split(/\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((text) => ({ type: "paragraph" as const, text }));
}

function parseClock(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return { dayOffset: 0, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function parseTime(text: string): TimelineTime {
  const match = text.match(timeMarker);
  if (!match?.[2]) return { display: "时间待整理", precision: "relative" };
  const hasRange = Boolean(match[3]);
  const approximate = Boolean(match[1]);
  return {
    display: `${match[1] ?? ""}${match[2]}${hasRange ? `–${match[3]}` : ""}`,
    precision: hasRange ? "range" : approximate ? "approximate" : "exact",
    start: parseClock(match[2]),
    ...(match[3] ? { end: parseClock(match[3]) } : {}),
  };
}

function timelineParts(text: string) {
  return text
    .split(splitMarker)
    .map((part) => part.trim())
    .filter(Boolean);
}

function timelineEntries(text: string, prefix: string, warnings: MigrationWarning[], characterNames: Array<{ id: string; name: string }>, includeParticipants = false) {
  const supplemental: string[] = [];
  const entries = timelineParts(text).map((part, index) => {
    const time = parseTime(part);
    const hasTime = time.precision !== "relative";
    if (!hasTime) {
      supplemental.push(part);
      warnings.push({ path: prefix, message: `第 ${index + 1} 段无法识别时间，已保留为补充内容` });
    }
    const marker = part.match(timeMarker);
    const content = marker && marker.index === 0 ? part.slice(marker[0].length).trim() : part;
    const participantIds = characterNames.filter((character) => part.includes(character.name)).map((character) => character.id);
    return {
      id: `${prefix.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${index + 1}`,
      time,
      title: `事件 ${index + 1}`,
      content: blocks(content || part),
      characterIds: participantIds,
      clueIds: [],
      ...(includeParticipants && participantIds.length ? { participantIds } : {}),
    };
  });
  const timedEntries = entries.filter((entry) => entry.time.precision !== "relative");
  // 如果整段使用“戌时/一炷香”等非 HH:mm 表达，保留为相对时间事件；
  // 只有在同一段同时存在明确时刻时，才把无法拆分的尾部移入 supplemental。
  return { entries: timedEntries.length ? timedEntries : entries, supplemental: timedEntries.length ? supplemental : [] };
}

function clueIdsForEvidenceName(name: string, index: number, clues: ScriptDoc["clues"], warnings: MigrationWarning[]) {
  const matches = clues.filter((clue) => clue.name.includes(name) || name.includes(clue.name));
  if (matches.length === 1) return matches[0].id;
  warnings.push({ path: `truth.keyEvidence[${index}]`, message: `无法唯一映射到线索 ID：${name}` });
  return null;
}

/** 将 V1 长文本包装为 V2 语义结构；不猜测原文没有提供的事实。 */
export function migrateV1ToV2(input: ScriptDoc): MigrationResult {
  const warnings: MigrationWarning[] = [];
  const locationIds = new Map(input.locations.map((name, index) => [name, `location_${index + 1}`]));
  const characterRefs = input.characters.map((character) => ({ id: character.id, name: character.name }));
  const truthTimeline = timelineEntries(input.truth.fullTimeline, "truth_event", warnings, characterRefs, true);

  if (!input.truth.fullTimeline.match(timeMarker)) warnings.push({ path: "truth.fullTimeline", message: "未识别到时间标记" });
  if (!input.truth.keyEvidence.length) warnings.push({ path: "truth.keyEvidence", message: "V1 没有关键证据列表" });
  warnings.push({ path: "truth.motive", message: "V1 没有独立动机字段，未凭空生成" });
  const evidenceLinks = input.truth.keyEvidence.map((name, index) => ({ name, clueId: clueIdsForEvidenceName(name, index, input.clues, warnings) }));

  const doc = parseScriptDocV2({
    version: 2,
    meta: input.meta,
    background: blocks(input.background),
    characters: input.characters.map((character, characterIndex) => {
      const timeline = timelineEntries(character.card.timeline, `character_${character.id}_event`, warnings, characterRefs);
      if (timeline.supplemental.length) warnings.push({ path: `characters.${characterIndex}.card.timeline`, message: "存在未按时间拆分的补充文本，已保留为相对事件" });
      return {
        id: character.id,
        name: character.name,
        ...(character.gender ? { gender: character.gender } : {}),
        ...(character.age ? { age: character.age } : {}),
        publicProfile: { bio: blocks(character.publicBio), relationships: [] },
        privateCard: {
          backstory: blocks(character.card.backstory),
          secrets: [{ id: `secret_${character.id}_1`, title: "核心秘密", content: blocks(character.card.secret), disclosure: "never" as const }],
          objectives: [{ id: `objective_${character.id}_1`, title: "本局目标", content: blocks(character.card.goal), priority: "primary" as const }],
          timeline: timeline.entries.length
            ? timeline.entries
            : [
                {
                  id: `character_${character.id}_event_1`,
                  time: { display: "时间待整理", precision: "relative" as const },
                  title: "补充经历",
                  content: blocks(character.card.timeline),
                  characterIds: [],
                  clueIds: [],
                },
              ],
          knowledge: character.card.knowledge.map((item, index) => ({
            id: `knowledge_${character.id}_${index + 1}`,
            title: `情报 ${index + 1}`,
            content: blocks(item),
            source: "other" as const,
            relatedCharacterIds: [],
            relatedClueIds: [],
          })),
          relationships: [],
          persona: { traits: [], speechStyle: character.card.persona, habits: [], taboos: [] },
          isCulprit: character.card.isCulprit,
        },
      };
    }),
    locations: input.locations.map((name, index) => ({ id: locationIds.get(name) ?? `location_${index + 1}`, name, description: [] })),
    clues: input.clues.map((clue) => ({
      id: clue.id,
      locationId: locationIds.get(clue.location) ?? "location_1",
      name: clue.name,
      category: "other" as const,
      content: blocks(clue.content),
      policy: clue.policy,
      relatedCharacterIds: [],
      relatedTruthEventIds: [],
    })),
    truth: {
      culpritId: input.truth.culprit,
      motive: [],
      method: { summary: blocks(input.truth.method), steps: [{ id: "method_step_1", title: "作案手法", content: blocks(input.truth.method), clueIds: [] }] },
      timeline: truthTimeline.entries.map((entry) => ({ ...entry, participantIds: entry.participantIds ?? [], characterIds: entry.characterIds ?? [] })),
      keyEvidenceIds: evidenceLinks.flatMap((entry) => (entry.clueId ? [entry.clueId] : [])),
      evidenceChain: evidenceLinks
        .map((entry, index) => ({ id: `evidence_${index + 1}`, clueIds: entry.clueId ? [entry.clueId] : [], conclusion: entry.name }))
        .filter((entry) => entry.clueIds.length > 0),
      redHerrings: [],
      supplemental: truthTimeline.supplemental.length ? blocks(truthTimeline.supplemental.join("\n")) : [],
      reveal: blocks(input.truth.reveal),
    },
    flow: input.flow,
    ending: {
      outcomes: [
        { result: "culprit_caught" as const, title: "真凶被捕", content: blocks(input.ending.winText) },
        { result: "culprit_escaped" as const, title: "真凶逃脱", content: blocks(input.ending.winText) },
      ],
    },
  });

  return { doc, warnings };
}
