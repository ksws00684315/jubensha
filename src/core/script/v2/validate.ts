import type { Narrative, ScriptDocV2, TimelineTime } from "./schema";
import { isPlaceholderTimelineTime, isPlaceholderTimelineTitle, isTruncatedTimelineText } from "./timeline";
import { narrativeToText } from "../compat";

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
  title: string;
  content: Narrative;
  time: TimelineTime;
  locationId?: string;
  characterIds: string[];
  clueIds: string[];
  truthEventId?: string;
};

/**
 * 时间线内容完整性（此前只校验了顺序，导致全库 99.7% 的「事件 N」占位标题一路过关）：
 *  - 占位标题 → 会原样进入 AI prompt 与 DM 复盘宣读，必须报；
 *  - 首尾明显被切断的条目 → 渲染层无法还原，报出来交作者重写。
 */
function checkTimelineContent(issues: ScriptV2Issue[], entries: TimelineEntryLike[], path: string) {
  for (const [index, entry] of entries.entries()) {
    if (isPlaceholderTimelineTitle(entry.title)) {
      issue(
        issues,
        "warning",
        `${path}.${index}.title`,
        `时间线标题是机械占位「${entry.title.trim()}」，不含任何信息；它会被念进 AI 上下文与复盘宣读，请改为事件摘要`
      );
    }
    if (isPlaceholderTimelineTime(entry.time.display)) {
      issue(issues, "error", `${path}.${index}.time.display`, `时间线时间仍是占位值「${entry.time.display.trim()}」，请填写具体时刻或有意义的相对时间`);
    } else if (entry.time.precision === "relative" && /^(?:前后|稍后|之后|期间|某时|当时|夜间|白天)$/.test(entry.time.display.trim())) {
      issue(issues, "warning", `${path}.${index}.time.display`, "相对时间标签缺少可识别的事件或时段信息，建议补充具体时段");
    }
    if (isTruncatedTimelineText(narrativeToText(entry.content))) {
      issue(issues, "warning", `${path}.${index}.content`, "时间线条目首尾被截断（缺上一句或下一句），建议重写为完整叙述");
    }
  }
}

function checkTimelineEntries(issues: ScriptV2Issue[], entries: TimelineEntryLike[], path: string, locationIds: Set<string>, clueIds: Set<string>, characterIds: Set<string>, truthEventIds?: Set<string>) {
  checkUniqueIds(issues, entries, path);
  checkTimelineOrder(issues, entries, path);
  checkTimelineContent(issues, entries, path);
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
    for (const [sIndex, secret] of character.privateCard.secrets.entries()) {
      if (!secret.trigger) continue;
      checkRefs(issues, secret.trigger.publicClueIds, clueIds, `characters.${index}.privateCard.secrets.${sIndex}.trigger.publicClueIds`);
      if (secret.trigger.actId && !doc.flow.acts.some((act) => act.id === secret.trigger?.actId)) {
        issue(issues, "error", `characters.${index}.privateCard.secrets.${sIndex}.trigger.actId`, `幕不存在: ${secret.trigger.actId}`);
      }
      if (secret.disclosure !== "conditional") {
        issue(issues, "warning", `characters.${index}.privateCard.secrets.${sIndex}.trigger`, "trigger 只对 conditional 秘密自动生效");
      }
    }
    for (const [dIndex, hook] of character.privateCard.defenseHooks.entries()) {
      checkRefs(issues, hook.brokenByPublicClueIds, clueIds, `characters.${index}.privateCard.defenseHooks.${dIndex}.brokenByPublicClueIds`);
    }
    if (!character.privateCard.isCulprit && character.privateCard.defenseHooks.length) {
      issue(issues, "warning", `characters.${index}.privateCard.defenseHooks`, "通常只为真凶配置辩解钩子；请确认这不是误填");
    }
  }

  for (const [index, clue] of doc.clues.entries()) {
    if (!locationIds.has(clue.locationId)) issue(issues, "error", `clues.${index}.locationId`, `地点不存在: ${clue.locationId}`);
    checkRefs(issues, clue.relatedCharacterIds, characterIds, `clues.${index}.relatedCharacterIds`);
    checkRefs(issues, clue.relatedTruthEventIds, truthEventIds, `clues.${index}.relatedTruthEventIds`);
    if (characterIds.size > 0 && characterIds.size <= clue.forbiddenCharacterIds.length && [...characterIds].every((id) => clue.forbiddenCharacterIds.includes(id))) {
      issue(issues, "error", `clues.${index}.forbiddenCharacterIds`, "这张线索禁止所有角色搜取，材料不可达");
    }
    if (clue.release?.round !== undefined && clue.release.round > doc.flow.searchRounds) {
      issue(issues, "error", `clues.${index}.release.round`, `release.round(${clue.release.round})超过搜证轮数(${doc.flow.searchRounds})，材料不可达`);
    }
  }
  // 线索公开前置必须是无环图，否则所有环内材料都会永久不可达。
  const releaseGraph = new Map<string, string[]>();
  for (const clue of doc.clues) releaseGraph.set(clue.id, clue.release?.afterCluePublicIds ?? []);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walkRelease = (id: string, path: string[]): void => {
    if (visiting.has(id)) {
      issue(issues, "error", `clues.${doc.clues.findIndex((clue) => clue.id === id)}.release.afterCluePublicIds`, `线索公开前置存在循环：${[...path, id].join(" → ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of releaseGraph.get(id) ?? []) walkRelease(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of releaseGraph.keys()) walkRelease(id, []);
  for (const [index, item] of (doc.hostGuide?.guaranteedPublicClues ?? []).entries()) {
    if (!clueIds.has(item.clueId)) issue(issues, "error", `hostGuide.guaranteedPublicClues.${index}.clueId`, `线索不存在: ${item.clueId}`);
    const clue = doc.clues.find((c) => c.id === item.clueId);
    if (clue?.policy === "keep_private") issue(issues, "error", `hostGuide.guaranteedPublicClues.${index}.clueId`, "keep_private 线索不能配置为主持保证公开");
    if (item.deadlineRound > doc.flow.searchRounds) issue(issues, "warning", `hostGuide.guaranteedPublicClues.${index}.deadlineRound`, `截止轮次(${item.deadlineRound})超过搜证轮数(${doc.flow.searchRounds})`);
    if (clue?.release?.round !== undefined && clue.release.round > item.deadlineRound) {
      issue(issues, "error", `hostGuide.guaranteedPublicClues.${index}.deadlineRound`, `保证公开早于线索 release.round(${clue.release.round})，运行时无法满足`);
    }
    if (clue?.release?.afterCluePublicIds?.includes(item.clueId)) {
      issue(issues, "error", `hostGuide.guaranteedPublicClues.${index}.clueId`, "线索不能依赖自己公开，存在循环前置");
    }
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
    } else {
      // 人证物证交叉：证词/文书类与实物类至少各一；全同类的链容易被整体推翻
      const categories = chain.clueIds
        .map((id) => doc.clues.find((c) => c.id === id)?.category)
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      const hasTestimony = categories.some((c) => c === "testimony" || c === "document");
      const hasPhysical = categories.some((c) => c === "object" || c === "trace" || c === "medical" || c === "digital");
      if (categories.length >= 2 && !(hasTestimony && hasPhysical)) {
        issue(issues, "warning", `truth.evidenceChain.${index}.clueIds`, "证据链缺少人证/物证交叉（全部为同类线索，容易被整体推翻）");
      }
    }
  }
  for (const [index, herring] of doc.truth.redHerrings.entries()) checkRefs(issues, herring.clueIds, clueIds, `truth.redHerrings.${index}.clueIds`);

  // R1 线索池预算：全场最多发现 人数×搜证轮数 张卡，超出必有线索永不出现（按实际角色数计）
  const maxDiscoverable = doc.characters.length * doc.flow.searchRounds;
  if (doc.clues.length > maxDiscoverable) {
    issue(issues, "error", "clues", `线索数(${doc.clues.length})超过可发现上限(${doc.characters.length}人×${doc.flow.searchRounds}轮=${maxDiscoverable})，必有线索永不出现`);
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
      if (skill.effect === "verify" && skill.phase !== "DISCUSSION") {
        issue(issues, "warning", `characters.${index}.privateCard.skills.${sIndex}.phase`, `质询技能「${skill.name}」设在 ${skill.phase} 阶段，但质询依赖「当众作答」机制、只在讨论阶段可用，该卡将永远无法发动`);
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

  // 复盘答题：模式与题目匹配；选项 id / 正确项 / 题目 id 校验
  if (doc.flow.voteMode === "culprit" && doc.ending.quiz.length > 0) {
    issue(issues, "warning", "ending.quiz", "culprit 模式忽略 quiz，如需答题请用 hybrid/choice");
  }
  if (doc.flow.voteMode !== "culprit" && doc.ending.quiz.length === 0) {
    issue(issues, "error", "ending.quiz", `voteMode=${doc.flow.voteMode} 需要至少一道复盘答题题`);
  }
  checkUniqueIds(issues, doc.ending.quiz, "ending.quiz");
  for (const [index, question] of doc.ending.quiz.entries()) {
    const optionIds = new Set(question.options.map((option) => option.id));
    if (optionIds.size !== question.options.length) {
      issue(issues, "error", `ending.quiz.${index}.options`, `题目「${question.prompt}」存在重复选项 id`);
    }
    if (!optionIds.has(question.correctOptionId)) {
      issue(issues, "error", `ending.quiz.${index}.correctOptionId`, `题目「${question.prompt}」的正确项不在选项内`);
    }
  }

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
