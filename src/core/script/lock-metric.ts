import { narrativeToText } from "./compat";
import type { CharacterV2, ClueV2, ScriptDocV2 } from "./v2/schema";

/**
 * "几卡锁凶"指标：把剧本折算成"第 k 轮玩家实际能看到哪些文本"，再量出读出真凶需要几张卡。
 *
 * 只读、不入库、不改行为——它存在的理由是 `validate.ts` 的"单线索锁凶"只看作者自己声明的
 * `truth.evidenceChain`，从不检查桌上真正可见的材料，于是"声明四步链、实际一卡锁凶"能全绿入库。
 */

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPositions(text: string, re: RegExp): Array<{ at: number; term: string }> {
  const out: Array<{ at: number; term: string }> = [];
  for (const match of text.matchAll(new RegExp(re.source, "g"))) {
    const at = match.index ?? 0;
    const prefix = text.slice(Math.max(0, at - 12), at).split(/[\n。；;]/).pop() ?? "";
    if (/[不没未无莫别]/.test(prefix)) continue;
    out.push({ at, term: match[0] });
  }
  return out;
}

/** 语料里行为谓词高度口语化，按类别取词表而不是分词 */
const ACT_RE = /(劝酒|劝|催|递|换|调换|倒|斟|放|投|下药|下毒|注射|注入|推|锁|撕|挪|移|藏|撤|拿走|取走|动过|碰过|吩咐|要求|指使|逼|施压|塞给|交给|安排)/;
const AWARENESS_RE = /(明知|明明知道|知道|清楚|了解|听见[^。]{0,10}说|看到[^。]{0,10}说|故意|存心|特意|专门|心虚)/;
const VERDICT_RE = /(证明|不足以|不说明|不指认|由此可见|可见|这说明|足以说明|指认)/;
/**
 * 真凶姓名近旁紧跟这些词，才算"明知/自认"落在他头上——"听见老板对白秋池说"里的
 * 白秋池是受话人，不算。
 */
const KNOWS_AFTER_RE = /^.{0,8}?(知道|清楚|明知|了解|故意|存心|特意|专门|说过|说到|说“|声称|承认|提到)/;
/**
 * 落空点：卡上是否给了"这条观察本身可能不成立/不唯一"的出口。
 * 打掉**法律结论**的免责句（"不能证明他想致死"）不算出口——那正是应当搬进 hostGuide 的判词；
 * 打掉**观察或独占性**的（"她没看见杯中是否有胶囊"）才算，它才是新规范要求的竞争解释。
 */
const EXCULPATE_RE = /(没有?看见|没人看见|没有?看到|没人看到|未(?:见|曾)?看见|没有记录|未记|不确定|无法确认|谁都可能|人人都|任何人均|同样可以|也可能|可能是|共[用享]|公用|多人(?:使用|接触)|不能排除)/;

export interface LockClueFacts {
  clueId: string;
  name: string;
  category: ClueV2["category"];
  policy: ClueV2["policy"];
  /** 命中的真凶称呼（全名/名） */
  culpritTerms: string[];
  acts: string[];
  awareness: string[];
  verdicts: string[];
  /** 同一句内既有真凶姓名又有加害动作：这张卡直接指认了他 */
  accusing: boolean;
  /** 真凶姓名近旁就是"知道/说过/故意"：主观状态归到了他头上 */
  knowing: boolean;
  /** 卡上留有观察层面的竞争解释 */
  exculpated: boolean;
}

export interface LockCombination {
  count: number;
  clueIds: string[];
}

export interface LockRoundView {
  round: number;
  /** 保证共见：auto_public 达标 + 主持保证公开 */
  shared: string[];
  /** 不保证共见，但至少有座位能搜到（manual_public / keep_private） */
  held: string[];
  /** 三要素齐备的单卡 */
  singleCardClueIds: string[];
  /** 在 shared 内凑齐三要素的最少卡数；null = 凑不齐 */
  lockInShared: LockCombination | null;
  /** shared ∪ held 内的最少卡数 */
  lockInTable: LockCombination | null;
}

export interface LockMetricReport {
  title: string;
  culpritId: string;
  culpritName: string;
  clueCount: number;
  namingClueIds: string[];
  /** 同一句里点名真凶并写了加害动作的卡：桌面上的"指认卡" */
  accusingClueIds: string[];
  verdictClueIds: string[];
  /** 抹名式目击：证词里"亲眼看见/亲耳听到"与"有人/那人/没看清"同现 */
  blankedWitnesses: Array<{ characterId: string; characterName: string; section: string; excerpt: string }>;
  rounds: LockRoundView[];
  /** 最早出现"两卡内锁凶"的搜证轮（按 shared ∪ held 口径） */
  earliestTwoCardLockRound: number | null;
}

function rawHits(text: string, re: RegExp): string[] {
  return [...text.matchAll(new RegExp(re.source, "g"))].map((m) => m[0]);
}

function culpritTerms(name: string): string[] {
  const trimmed = name.trim();
  const terms = [trimmed];
  if (trimmed.length >= 3) terms.push(trimmed.slice(1));
  return terms;
}

function mentionPositions(text: string, terms: string[]): Array<{ at: number; term: string }> {
  if (!terms.length) return [];
  return assertPositions(text, new RegExp(terms.map(escapeRe).join("|"), "g"));
}

function sentenceOf(text: string, at: number): string {
  let start = 0;
  for (const d of ["\n", "。", "；", ";"]) start = Math.max(start, text.lastIndexOf(d, at) + 1);
  let end = text.length;
  for (const d of ["\n", "。", "；", ";"]) {
    const found = text.indexOf(d, at);
    if (found !== -1 && found < end) end = found;
  }
  return text.slice(start, end);
}

function clueTextOf(clue: ClueV2): string {
  return `${clue.name}\n${narrativeToText(clue.content)}`;
}

export function analyzeClue(doc: ScriptDocV2, clue: ClueV2): LockClueFacts {
  const culprit = doc.characters.find((c) => c.id === doc.truth.culpritId);
  const text = clueTextOf(clue);
  const mentions = culprit ? mentionPositions(text, culpritTerms(culprit.name)) : [];
  const acts = assertPositions(text, ACT_RE);
  const awareness = assertPositions(text, AWARENESS_RE);
  const accusing = mentions.some((m) => acts.some((a) => sentenceOf(text, m.at) === sentenceOf(text, a.at)));
  return {
    clueId: clue.id,
    name: clue.name,
    category: clue.category,
    policy: clue.policy,
    culpritTerms: mentions.map((m) => m.term),
    acts: acts.map((a) => a.term),
    awareness: awareness.map((a) => a.term),
    verdicts: rawHits(text, VERDICT_RE),
    accusing,
    knowing: mentions.some((m) => KNOWS_AFTER_RE.test(text.slice(m.at + m.term.length, m.at + m.term.length + 12))),
    exculpated: EXCULPATE_RE.test(text),
  };
}

/** 该卡对哪些座位可搜：全员禁搜、或房间主人包场即不可达 */
function reachableSeats(doc: ScriptDocV2, clue: ClueV2): number {
  const owner = doc.locations.find((l) => l.id === clue.locationId)?.ownerCharacterId;
  return doc.characters.filter((c) => !clue.forbiddenCharacterIds.includes(c.id) && c.id !== owner).length;
}

function releaseSatisfied(clue: ClueV2, round: number, publicIds: Set<string>): boolean {
  if (clue.release?.round !== undefined && clue.release.round > round) return false;
  return (clue.release?.afterCluePublicIds ?? []).every((id) => publicIds.has(id));
}

/**
 * 第 round 轮的"保证共见"集合：不动点迭代，因为 `afterCluePublicIds` 的前置本身
 * 也要先公开。manual_public 只进 held——持有者可以念出来，但没有任何机制保证。
 */
function visibilityAt(doc: ScriptDocV2, round: number): { shared: string[]; held: string[] } {
  const guaranteed = new Map(doc.hostGuide?.guaranteedPublicClues?.map((g) => [g.clueId, g.deadlineRound]) ?? []);
  const publicIds = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const clue of doc.clues) {
      if (publicIds.has(clue.id)) continue;
      const forced = (guaranteed.get(clue.id) ?? Infinity) <= round;
      if (clue.policy !== "auto_public" && !forced) continue;
      if (!releaseSatisfied(clue, round, publicIds)) continue;
      publicIds.add(clue.id);
      changed = true;
    }
  }
  const shared = [...publicIds];
  const held = doc.clues
    .filter((clue) => !publicIds.has(clue.id) && clue.policy !== "auto_public")
    .filter((clue) => releaseSatisfied(clue, round, publicIds) && reachableSeats(doc, clue) > 0)
    .map((clue) => clue.id);
  return { shared, held };
}

function covers(facts: LockClueFacts): { identity: boolean; act: boolean; awareness: boolean } {
  return { identity: facts.culpritTerms.length > 0, act: facts.acts.length > 0, awareness: facts.awareness.length > 0 };
}

/**
 * 单卡锁凶（严格口径）：一张卡同时把 姓名＋加害行为＋明知 落到真凶头上，
 * 且卡上没有"这条观察可能不成立"的出口。这是唯一适合升级为 error 的判据。
 */
export function isSingleCardLock(facts: LockClueFacts): boolean {
  return facts.culpritTerms.length > 0 && facts.accusing && facts.knowing && !facts.exculpated;
}

/** ≤3 卡组合搜索：候选只留"至少命中一个要素"的卡，其余卡对锁凶无贡献 */
function minimalLock(ids: string[], facts: Map<string, LockClueFacts>): LockCombination | null {
  const candidates = ids.filter((id) => {
    const f = facts.get(id);
    return f !== undefined && (f.culpritTerms.length > 0 || f.acts.length > 0 || f.awareness.length > 0);
  });
  const full = (list: LockClueFacts[]) => {
    const all = list.map(covers);
    return all.some((c) => c.identity) && all.some((c) => c.act) && all.some((c) => c.awareness);
  };
  const of = (ids_: string[]) => ids_.map((id) => facts.get(id)!);
  for (const a of candidates) if (isSingleCardLock(facts.get(a)!)) return { count: 1, clueIds: [a] };
  for (const a of candidates)
    for (const b of candidates)
      if (a < b && full(of([a, b]))) return { count: 2, clueIds: [a, b] };
  for (const a of candidates)
    for (const b of candidates)
      for (const c of candidates)
        if (a < b && b < c && full(of([a, b, c]))) return { count: 3, clueIds: [a, b, c] };
  return null;
}

const WITNESS_RE = /(亲眼看见|亲耳听到|亲眼看到|看见|听到)([^。]{0,30})/g;
const VAGUE_RE = /有人|那人|某个身影|一个身影|不知是谁|没看清|看不清|不知道是谁/;

function characterNarratives(character: CharacterV2) {
  return [
    ["timeline", character.privateCard.timeline.map((e) => `${e.title} ${narrativeToText(e.content)}`)],
    ["objectives", character.privateCard.objectives.map((o) => `${o.title} ${narrativeToText(o.content)}`)],
    ["knowledge", character.privateCard.knowledge.map((k) => `${k.title} ${narrativeToText(k.content)}`)],
    ["secrets", character.privateCard.secrets.map((s) => `${s.title} ${narrativeToText(s.content)}`)],
  ] as const;
}

export function computeLockMetric(doc: ScriptDocV2): LockMetricReport {
  const culprit = doc.characters.find((c) => c.id === doc.truth.culpritId);
  const facts = new Map(doc.clues.map((clue) => [clue.id, analyzeClue(doc, clue)]));
  const namingClueIds = doc.clues.filter((c) => facts.get(c.id)!.culpritTerms.length > 0).map((c) => c.id);
  const accusingClueIds = doc.clues.filter((c) => facts.get(c.id)!.accusing).map((c) => c.id);
  const verdictClueIds = doc.clues.filter((c) => facts.get(c.id)!.verdicts.length > 0).map((c) => c.id);

  const blankedWitnesses: LockMetricReport["blankedWitnesses"] = [];
  for (const character of doc.characters) {
    if (character.privateCard.isCulprit) continue;
    for (const [section, lines] of characterNarratives(character)) {
      for (const line of lines) {
        for (const match of line.matchAll(WITNESS_RE)) {
          if (!VAGUE_RE.test(match[2] ?? "")) continue;
          blankedWitnesses.push({ characterId: character.id, characterName: character.name, section, excerpt: match[0] });
          break;
        }
      }
    }
  }

  const rounds: LockRoundView[] = [];
  for (let round = 1; round <= doc.flow.searchRounds; round += 1) {
    const { shared, held } = visibilityAt(doc, round);
    rounds.push({
      round,
      shared,
      held,
      singleCardClueIds: [...shared, ...held].filter((id) => isSingleCardLock(facts.get(id)!)),
      lockInShared: minimalLock(shared, facts),
      lockInTable: minimalLock([...shared, ...held], facts),
    });
  }

  return {
    title: doc.meta.title,
    culpritId: doc.truth.culpritId,
    culpritName: culprit?.name ?? doc.truth.culpritId,
    clueCount: doc.clues.length,
    namingClueIds,
    accusingClueIds,
    verdictClueIds,
    blankedWitnesses,
    rounds,
    earliestTwoCardLockRound: rounds.find((r) => r.lockInTable !== null && r.lockInTable.count <= 2)?.round ?? null,
  };
}
