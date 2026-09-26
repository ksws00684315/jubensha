import { createHash } from "node:crypto";
import { parseScriptDoc, type ScriptDoc } from "./schema";
import { migrateV1ToV2, type MigrationWarning } from "./v2/migrate-v1";
import { parseScriptDocV2, type CharacterV2, type ClueV2, type LocationV2, type Narrative, type ScriptDocV2 } from "./v2/schema";
import { isPlaceholderTimelineTitle } from "./v2/timeline";

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

/**
 * 解析结果进程内缓存（LRU ≤50 本）。
 * 房间页 2s 轮询与对局 GET 每次都重新 zod 校验整本书是首要 CPU 热点；
 * 内容 hash 即键，剧本编辑保存后 hash 变化自动失效，无需显式清缓存。
 * 缓存对象按只读约定共享——消费方（engine/api）不得原地修改 ScriptDocV2。
 */
const runtimeCache = new Map<string, ScriptDocV2>();
const RUNTIME_CACHE_MAX = 50;

function runtimeCacheKey(input: unknown): string | null {
  try {
    const raw = typeof input === "string" ? input : JSON.stringify(input);
    return createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export function parseScriptForRuntime(input: unknown): ScriptDocV2 {
  const key = runtimeCacheKey(input);
  if (key) {
    const hit = runtimeCache.get(key);
    if (hit) {
      runtimeCache.delete(key);
      runtimeCache.set(key, hit);
      return hit;
    }
  }
  const doc = ingestScriptDoc(input).doc;
  if (key) {
    runtimeCache.set(key, doc);
    if (runtimeCache.size > RUNTIME_CACHE_MAX) {
      const oldest = runtimeCache.keys().next().value;
      if (oldest !== undefined) runtimeCache.delete(oldest);
    }
  }
  return doc;
}

/** 仅供测试：清空解析缓存。 */
export function clearScriptRuntimeCache(): void {
  runtimeCache.clear();
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

/**
 * 时间线 → 文本（AI 玩家 system prompt / DM 复盘宣读共用）。
 * 占位标题（「事件 N」）直接丢弃，退化为「时刻 + 正文」——
 * prompt 与宣读里绝不应该出现「事件 1」这种无信息量标签。
 */
function titleRepeatsBody(title: string, body: string): boolean {
  const normalized = title.replace(/(?:…|\.\.\.)+$/g, "").trim();
  return normalized.length > 0 && body.startsWith(normalized);
}

export function timelineToText(entries: Array<{ time: { display: string }; title: string; content: Narrative }>) {
  return entries
    .map((entry) => {
      const body = narrativeToText(entry.content);
      const title = entry.title.trim();
      if (!title || isPlaceholderTimelineTitle(title) || titleRepeatsBody(title, body)) return `${entry.time.display} ${body}`;
      return `${entry.time.display} ${title}：${body}`;
    })
    .join("\n");
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

export type FinaleOutcome = {
  result: "caught" | "escaped";
  title: string;
  content: string;
  verdict: string;
};

/** 终局文案的唯一投影入口，防止把两个互斥 outcomes 同时展示。 */
export function resolveFinaleOutcome(
  doc: ScriptDocV2,
  voteResult: { culpritSeat: number; caught: boolean; tiedSeats?: number[] },
): FinaleOutcome {
  const caught = doc.flow.voteMode !== "choice" && voteResult.caught;
  const result = caught ? "caught" : "escaped";
  const selected = doc.ending.outcomes.find((outcome) => outcome.result === (caught ? "culprit_caught" : "culprit_escaped"));
  const culpritName = doc.characters.find((character) => character.id === doc.truth.culpritId)?.name ?? "真凶";
  const verdict = doc.flow.voteMode === "choice"
    ? "本局为复盘答题模式，以下公布案件还原。"
    : voteResult.culpritSeat < 0
      ? `本期真凶是「${culpritName}」，但该角色未在本局入座，指认无果。`
      : voteResult.tiedSeats?.length
        ? `投票出现平票，真凶「${culpritName}」逃脱。`
        : caught
          ? `真凶「${culpritName}」被成功指认。`
          : `真凶「${culpritName}」逃脱。`;
  return {
    result,
    title: selected?.title ?? (caught ? "真凶被捕" : "真凶逃脱"),
    content: selected ? narrativeToText(selected.content) : "",
    verdict,
  };
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
