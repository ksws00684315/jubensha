import { parseScriptDoc, type ScriptDoc } from "./schema";
import { parseScriptDocV2, type Narrative, type ScriptDocV2 } from "./v2/schema";

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

export function narrativeToText(blocks: Narrative): string {
  return blocks
    .map((block) => {
      if (block.type === "paragraph") return block.text;
      if (block.type === "quote") return `${block.text}${block.attribution ? `——${block.attribution}` : ""}`;
      return block.items.map((item, index) => `${block.style === "ordered" ? `${index + 1}. ` : "· "}${item}`).join("\n");
    })
    .join("\n\n");
}

function timelineToText(entries: Array<{ time: { display: string }; title: string; content: Narrative }>) {
  return entries.map((entry) => `${entry.time.display} ${entry.title}：${narrativeToText(entry.content)}`).join("\n");
}

/** 将 V2 投影为现有引擎与 AI 所需的 V1 视图，保持旧运行时行为不变。 */
export function toLegacyScriptDoc(doc: ScriptDocV2): ScriptDoc {
  const locationNames = new Map(doc.locations.map((location) => [location.id, location.name]));
  const eventText = timelineToText(doc.truth.timeline);
  const supplemental = narrativeToText(doc.truth.supplemental);
  const fullTimeline = [eventText, supplemental].filter(Boolean).join("\n\n");

  return {
    version: 1,
    meta: doc.meta,
    background: narrativeToText(doc.background),
    characters: doc.characters.map((character) => ({
      id: character.id,
      name: character.name,
      ...(character.gender ? { gender: character.gender } : {}),
      ...(character.age ? { age: character.age } : {}),
      publicBio: [character.publicProfile.identity, narrativeToText(character.publicProfile.bio)].filter(Boolean).join("："),
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
    locations: doc.locations.map((location) => location.name),
    clues: doc.clues.map((clue) => ({
      id: clue.id,
      location: locationNames.get(clue.locationId) ?? clue.locationId,
      name: clue.name,
      content: narrativeToText(clue.content),
      policy: clue.policy,
    })),
    truth: {
      culprit: doc.truth.culpritId,
      method: narrativeToText(doc.truth.method.summary),
      fullTimeline,
      keyEvidence: doc.truth.keyEvidenceIds.map((id) => doc.clues.find((clue) => clue.id === id)?.name ?? id),
      reveal: narrativeToText(doc.truth.reveal),
    },
    flow: doc.flow,
    ending: {
      winText: doc.ending.outcomes
        .map((outcome) => `${outcome.title}：${narrativeToText(outcome.content)}`)
        .join("\n\n"),
    },
  };
}

export function parseScriptForRuntime(input: unknown): ScriptDoc {
  const parsed = parseAnyScriptDoc(input);
  return parsed.version === 2 ? toLegacyScriptDoc(parsed.doc) : parsed.doc;
}

export function legacyScriptDocOf(input: AnyScriptDoc): ScriptDoc {
  return "version" in input && input.version === 2 ? toLegacyScriptDoc(input) : input;
}
