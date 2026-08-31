import { parseScriptDoc, type ScriptDoc } from "./schema";
import { migrateV1ToV2, type MigrationWarning } from "./v2/migrate-v1";
import { parseScriptDocV2, type CharacterV2, type ClueV2, type LocationV2, type Narrative, type ScriptDocV2 } from "./v2/schema";

export type AnyScriptDoc = ScriptDoc | ScriptDocV2;
export type ParsedScriptDoc =
  | { version: 1; doc: ScriptDoc }
  | { version: 2; doc: ScriptDocV2 };

export function parseAnyScriptDoc(input: unknown): ParsedScriptDoc {
  if (typeof input === "object" && input !== null && (input as { version?: unknown }).version === 2) {
    return { version: 2, doc: parseScriptDocV2(input) };
  }
  return { version: 1, doc: parseScriptDoc(input) };
}

/** 读取任意版本并得到运行时/存储用的 V2。V1 走确定性迁移。 */
export function ingestScriptDoc(input: unknown): { doc: ScriptDocV2; migrationWarnings: MigrationWarning[] } {
  const parsed = parseAnyScriptDoc(input);
  if (parsed.version === 2) return { doc: parsed.doc, migrationWarnings: [] };
  const migrated = migrateV1ToV2(parsed.doc);
  return { doc: migrated.doc, migrationWarnings: migrated.warnings };
}

export function parseScriptForRuntime(input: unknown): ScriptDocV2 {
  return ingestScriptDoc(input).doc;
}

export function narrativeToText(blocks: Narrative): string {
  return blocks
    .map((block) => {
      if (block.type === "paragraph") return block.text;
      if (block.type === "quote") return `${block.text}${block.attribution ? `——${block.attribution}` : ""}`;
      return block.items.map((item, index) => `${block.style === "ordered" ? `${index + 1}. ` : "· "}${item}`).join("\n");
    })
    .join("\n\n");
}

export function timelineToText(entries: Array<{ time: { display: string }; title: string; content: Narrative }>) {
  return entries.map((entry) => `${entry.time.display} ${entry.title}：${narrativeToText(entry.content)}`).join("\n");
}

export function publicBioText(character: CharacterV2): string {
  return [character.publicProfile.identity, narrativeToText(character.publicProfile.bio)].filter(Boolean).join("：");
}

export function clueText(clue: ClueV2): string {
  return narrativeToText(clue.content);
}

export function locationNameOf(doc: ScriptDocV2, locationId: string): string {
  return doc.locations.find((location) => location.id === locationId)?.name ?? locationId;
}

export function resolveLocation(doc: ScriptDocV2, key: string): LocationV2 | undefined {
  return doc.locations.find((location) => location.id === key || location.name === key);
}

export function locationNames(doc: ScriptDocV2): string[] {
  return doc.locations.map((location) => location.name);
}

export function methodText(doc: ScriptDocV2): string {
  return narrativeToText(doc.truth.method.summary);
}

export function fullTimelineText(doc: ScriptDocV2): string {
  const eventText = timelineToText(doc.truth.timeline);
  const supplemental = narrativeToText(doc.truth.supplemental);
  return [eventText, supplemental].filter(Boolean).join("\n\n");
}

export function revealText(doc: ScriptDocV2): string {
  return narrativeToText(doc.truth.reveal);
}

export function winText(doc: ScriptDocV2): string {
  return doc.ending.outcomes.map((outcome) => `${outcome.title}：${narrativeToText(outcome.content)}`).join("\n\n");
}

export function keyEvidenceNames(doc: ScriptDocV2): string[] {
  return doc.truth.keyEvidenceIds.map((id) => doc.clues.find((clue) => clue.id === id)?.name ?? id);
}

/** 测试与一次性对照用：把 V2 压成旧引擎视图。运行时不要走这条路径。 */
export function toLegacyScriptDoc(doc: ScriptDocV2): ScriptDoc {
  return {
    version: 1,
    meta: doc.meta,
    background: narrativeToText(doc.background),
    characters: doc.characters.map((character) => ({
      id: character.id,
      name: character.name,
      ...(character.gender ? { gender: character.gender } : {}),
      ...(character.age ? { age: character.age } : {}),
      publicBio: publicBioText(character),
      card: {
        backstory: narrativeToText(character.privateCard.backstory),
        secret: character.privateCard.secrets.map((secret) => `${secret.title}：${narrativeToText(secret.content)}`).join("\n\n"),
        goal: character.privateCard.objectives.map((objective) => `${objective.title}：${narrativeToText(objective.content)}`).join("\n\n"),
        isCulprit: character.privateCard.isCulprit,
        timeline: timelineToText(character.privateCard.timeline),
        knowledge: character.privateCard.knowledge.map((item) => `${item.title}：${narrativeToText(item.content)}`),
        persona: [character.privateCard.persona.speechStyle, ...character.privateCard.persona.traits].filter(Boolean).join("；"),
      },
    })),
    locations: locationNames(doc),
    clues: doc.clues.map((clue) => ({
      id: clue.id,
      location: locationNameOf(doc, clue.locationId),
      name: clue.name,
      content: clueText(clue),
      policy: clue.policy,
    })),
    truth: {
      culprit: doc.truth.culpritId,
      method: methodText(doc),
      fullTimeline: fullTimelineText(doc),
      keyEvidence: keyEvidenceNames(doc),
      reveal: revealText(doc),
    },
    flow: doc.flow,
    ending: { winText: winText(doc) },
  };
}
