import type { ChatMessage, PromptAssembly } from "@/core/llm/types";
import { composeSegments } from "@/core/llm/prompt-segments";
import type { EngineEvent, GameState } from "@/core/engine/types";
import { unlockedActs } from "@/core/engine/flow";
import { clueMentionHints, renderLogWithMemory } from "./memory";
import { buildPublicEvidenceRegistry, renderPublicEvidenceRegistry } from "./evidence";
import type { KnowledgeV2 } from "@/core/script/v2/schema";

/** knowledge 的情报性质前缀：防 AI 把听来的传闻当亲见事实 */
const KIND_LABEL: Record<string, string> = { fact: "亲见", claim: "传闻", inference: "推断" };

function knowledgeLine(item: KnowledgeV2): string {
  const kind = KIND_LABEL[item.kind] ?? "亲见";
  return `· 【${kind}】${item.title}：${narrativeToText(item.content)}`;
}

function typedSecretReady(secret: { trigger?: { round?: number; actId?: string; publicClueIds?: string[] }; id: string }, script: ScriptDocV2, state: GameState, seatIndex: number): boolean {
  const trigger = secret.trigger;
  if (!trigger) return false;
  if (trigger.round !== undefined && state.round < trigger.round) return false;
  if (trigger.actId) {
    const act = script.flow.acts.find((item) => item.id === trigger.actId);
    if (!act || state.round < act.roundStart) return false;
  }
  if ((trigger.publicClueIds ?? []).some((id) => !state.clueStates[id]?.isPublic)) return false;
  return state.unlockedSecrets?.[`${seatIndex}:${secret.id}`] !== false;
}
import {
  clueText,
  fullTimelineText,
  keyEvidenceNames,
  locationNames,
  methodText,
  narrativeToText,
  publicBioText,
  revealText,
  timelineToText,
} from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

/**
 * ★ 信息防火墙 ★
 * 任何 AI 的 prompt 只能经由本文件构建。规则：
 *  - 玩家 agent：只能拿到「公共事件流 + 自己的角色卡 + 自己持有的线索 + 与自己相关的私聊」。
 *    truth 与其他座位的角色卡/线索在本文件中就不可达（类型与代码路径双重隔离）。
 *  - DM agent：看得到完整剧本，但 DM 的输出只作为系统/旁白消息，不参与投票。
 *
 * ★ 前缀缓存 ★
 * 所有 LLM 消息都走 cacheFriendlyMessages：system 整局不变；user = 只增不改的现场记录 + 每轮才变的尾部。
 * 开启滚动记忆（state.memory）后，现场记录的前缀会在摘要更新时整体替换一次——这是
 * 「上下文长度/质量」换「缓存命中」的主动取舍，见 memory.ts。
 */

export function seatOf(state: GameState, seatIndex: number) {
  return state.seats[seatIndex];
}

export function characterOf(script: ScriptDocV2, state: GameState, seatIndex: number) {
  const seat = seatOf(state, seatIndex);
  return script.characters.find((c) => c.id === seat.characterId);
}

export function heldCluesOf(script: ScriptDocV2, state: GameState, seatIndex: number) {
  return (state.heldClues[seatIndex] ?? []).map((id) => script.clues.find((c) => c.id === id)).filter(Boolean);
}

/** 稳定 system + 只追加的日志 + 每轮尾部。供前缀缓存命中。 */
export function cacheFriendlyMessages(system: string, growingLog: string, tail: string): ChatMessage[] {
  return [
    { role: "system", content: system.trim() },
    { role: "user", content: `${growingLog.trimEnd()}\n\n${tail.trim()}\n` },
  ];
}

type PlayerTask = "speech" | "answer" | "whisper" | "plan" | "search" | "question" | "vote";

function phaseInstruction(_script: ScriptDocV2, state: GameState, _seatIndex: number, hint?: string, task: PlayerTask = "speech"): string {
  switch (state.phase) {
    case "SELF_INTRO":
      return `现在是【自我介绍】环节。请以第一人称做一段 80-150 字的自我介绍：你是谁、与死者的关系、今晚大致做了什么（按你的角色卡时间线，注意保护你的秘密）。不要剧透游戏机制。`;
    case "DISCUSSION":
      if (task === "whisper") return `现在是【第 ${state.round} 轮私聊窗口】。只有你和对方能看到这段话；可以交换情报、试探、结盟或暂时敷衍，但仍须遵守自己的披露规则。${hint ? `私聊提示：${hint}` : ""}`;
      if (task === "answer") return `现在是【第 ${state.round} 轮质询回应】。请先正面回答对方刚问的具体问题，再补充有限解释；不必突破自己的秘密或披露限制。不要替别人作答。${hint ? `主持人提示：${hint}` : ""}`;
      return `现在是【第 ${state.round} 轮圆桌讨论】，按座位轮流发言。轮到你时做一段陈述；有人向你提问时请正面回答。不要连珠炮质问，不要替别人作答，也不要打断别人的回合。${hint ? `主持人提示：${hint}` : ""}`;
    case "SEARCH":
      return `现在是【第 ${state.round} 轮搜证】。`;
    case "VOTE":
      return `现在是【投票】环节。`;
    default:
      return `当前阶段：${state.phase}（第 ${state.round} 轮）。`;
  }
}

function publicRoster(script: ScriptDocV2, state: GameState): string {
  return state.seats
    .filter((s) => s.kind !== "empty")
    .map((s) => {
      const c = script.characters.find((ch) => ch.id === s.characterId);
      return `· 座位${s.index + 1} ${s.kind === "ai" ? "AI" : "真人"} ${s.playerName}${c ? ` 公开身份：${c.name}，${publicBioText(c)}` : ""}`;
    })
    .join("\n");
}

/**
 * 玩家 agent 的完整上下文（防火墙出口）。
 * 返回 messages + segments：segments 供 llm 客户端按分层预算降级（裁 log→丢 droppable→
 * anchored 永不降级），messages 即 composeSegments(segments) 的结果。
 */
export function buildPlayerContext(
  script: ScriptDocV2,
  state: GameState,
  seatIndex: number,
  events: EngineEvent[],
  opts: { hint?: string; extraInstruction?: string; requireJson?: string; recall?: string; taskType?: PlayerTask }
): PromptAssembly {
  const character = characterOf(script, state, seatIndex);
  if (!character) throw new Error(`座位 ${seatIndex} 未绑定角色`);

  const card = character.privateCard;
  const isCulprit = card.isCulprit;
  const heldClues = heldCluesOf(script, state, seatIndex);
  const publicClues = script.clues.filter((c) => state.clueStates[c.id]?.isPublic);
  // 公开证据是独立的事实层：即使玩家后来转交了卡，也仍应能回查公开原文。
  const clues = [...heldClues, ...publicClues.filter((c) => !heldClues.some((h) => h?.id === c.id))];

  const strategy = isCulprit
    ? `【你的处境】你就是真凶。你的首要目标是活过今晚：绝不能承认、绝不能供出手法细节。
- 坚守你的角色卡时间线（对时间线的叙述以你的角色卡为准，可以合理省略，但不要与卡片记录硬冲突）。
- 当有线索指向你时，用职业/性格上说得通的解释带过，并自然地把讨论引向其他人（有动机、有秘密的人）。
- 不要撒连自己都记不住的谎；少说细节，多反问。
- 你的一切发言都在伪造的"好人"身份下进行，语气要符合你的人设。`
    : `【你的处境】你是无辜者之一，同时也是局中人：你有自己的秘密和把柄。
- 第一目标是保护自己的秘密、别把自己洗成最大嫌疑人；找出真凶是次要的。
- 发言只使用已经公开的信息和你愿意拿出来的那部分私密情报。不要把只有你看见的细节讲成全场共识，更不要做完整的案情复盘。
- 信息不足时可以同时怀疑好几个人，不要表现得胸有成竹。
- 被逼问自己的秘密时可以回避或部分承认，但不要撒与自己时间线硬冲突的谎。`;

  const violationBlock = card.violation.length ? `红线（无论如何不能说破、不能做）：${card.violation.join("；")}` : "";
  const alibiBlock = card.alibi?.length ? `不在场证明（必要时可主动陈述）：${narrativeToText(card.alibi)}\n` : "";
  const tellBlock = card.tells.length ? `说谎时的小动作（演凶/撒谎时可带）：${card.tells.join("；")}\n` : "";
  const activeDefenseHooks = (card.defenseHooks ?? []).filter((hook) => !hook.brokenByPublicClueIds.some((id) => state.clueStates[id]?.isPublic));
  const defenseBlock = activeDefenseHooks.length
    ? `可使用的辩解（只可基于这里写明的依据陈述；对应击破材料公开后立刻停止使用）：\n${activeDefenseHooks.map((hook) => `- ${hook.claim}（依据：${hook.basis}）`).join("\n")}\n`
    : "";

  const system = `你正在参加一场文字剧本杀游戏《${script.meta.title}》，扮演其中一名角色。全程以第一人称、在戏内说话。

【公开背景】
${narrativeToText(script.background)}

【在场人物（仅公开身份）】
${publicRoster(script, state)}

【可搜证地点】${locationNames(script).join("、")}

【你的角色】${character.name}${character.gender ? `（${character.gender}）` : ""}${character.age ? ` ${character.age} 岁` : ""}
公开身份：${publicBioText(character)}
角色背景：${narrativeToText(card.backstory)}
  ${alibiBlock}你的秘密（只能按披露规则处理）：${card.secrets
    .map((secret) => {
      const disclosure = secret.disclosure === "must_share"
        ? "〔必须找机会说出去，可以说得含蓄，但不能瞒到底〕"
        : secret.disclosure === "conditional"
          ? `〔${!secret.trigger ? "需按公开记录判断；" : typedSecretReady(secret, script, state, seatIndex) ? "条件已满足；" : "条件尚未满足；"}满足条件后才可披露：${secret.condition ?? "以当前公开记录判断"}〕`
          : "〔绝不能主动披露；已经公开的事实可以按公开来源回应〕";
      return `${secret.title}${disclosure}：${narrativeToText(secret.content)}`;
    })
    .join("\n")}
你的目标：${card.objectives.map((objective) => `${objective.title}：${narrativeToText(objective.content)}`).join("\n")}
你的时间线（你自己的经历，可按此陈述）：${timelineToText(card.timeline)}
你额外知道的事：${card.knowledge.map(knowledgeLine).join("\n") || "（无）"}
你的说话风格：${[card.persona.speechStyle, ...card.persona.traits].filter(Boolean).join("；")}
${tellBlock}${defenseBlock}

${strategy}`;

  // 近因区：语气死锁与行为禁令放在紧邻生成点的 tail 尾部（格式指令之前），
  // 对冲长局历史对硬约束的稀释；system 仍是整局常量，不破坏前缀缓存。
  const hardTail = `【发言要求】
- 每次发言 60-180 字，中文，口语化，符合人设。不要输出任何舞台指示、括号动作或"我说"之类的前缀。
- 你看到的【线索·仅你可见】是你自己的情报，可以转述其中的内容（视为你亲手翻到的），但请用你的口吻，不要逐字念卡。
- 除你持有的线索外，你不知道任何未公开的信息；其他玩家说的都是他们的陈述，真假自辨。${violationBlock ? `\n${violationBlock}` : ""}`;

  const clueBlock =
    clues.length === 0
      ? "（暂无）"
      : clues.map((c) => `· ${c!.name}（${publicClues.includes(c!) ? "已公开" : "仅你可见"}）: ${clueText(c!)}`).join("\n");
  const publicEvidence = renderPublicEvidenceRegistry(buildPublicEvidenceRegistry(script, state, events));

  // 分层记忆：早期公共事件用滚动摘要，近期逐字保留（见 memory.ts）
  const growingLog = `【到目前为止的现场记录】
${renderLogWithMemory(events, seatIndex, state.memory, true)}`;

  const mentionHints = clueMentionHints(script, state, seatIndex, events);
  const mentionBlock = mentionHints.length
    ? `【可打出的牌】刚才大家提到了${mentionHints.map((n) => `「${n}」`).join("、")}——你手里正好有相关线索，可以在合适的时机用你的口吻亮出来（也可以继续藏着，看你的处境）。`
    : "";

  // 分幕读本：已解锁幕的阶段增量（新知识/新目标）注入尾部
  const acts = unlockedActs(script.flow.acts, state);
  let actBlock = "";
  if (acts.length) {
    const lines: string[] = [];
    for (const act of acts) {
      const stage = card.stages.find((s) => s.actId === act.id);
      if (!stage) continue;
      const parts = [
        ...stage.knowledge.map(knowledgeLine),
        ...stage.objectives.map((o) => `· 【新目标】${o.title}：${narrativeToText(o.content)}`),
      ];
      if (parts.length) lines.push(`（${act.title}）\n${parts.join("\n")}`);
    }
    if (lines.length) actBlock = `【本幕新知】\n${lines.join("\n")}\n`;
  }

  // droppable 按「先丢→后丢」排序：召回是模糊近似记忆最先牺牲，其次证据登记、可打出的牌
  const segments = {
    system,
    log: growingLog,
    anchoredHead: `【你持有的线索卡】\n${clueBlock}`,
    droppable: [
      opts.recall?.trim() ?? "",
      publicEvidence ? `【公开证据登记】\n${publicEvidence}` : "",
      mentionBlock,
    ],
    anchoredTail: `${actBlock}${phaseInstruction(script, state, seatIndex, opts.hint, opts.taskType)}

${hardTail}${opts.extraInstruction ? `\n\n${opts.extraInstruction}` : ""}${opts.requireJson ? `\n\n${opts.requireJson}` : ""}`,
  };
  return { messages: composeSegments(segments), segments };
}

function isRevealPhase(state: GameState) {
  return state.phase === "REVEAL" || state.phase === "ENDED";
}

function truthBrief(script: ScriptDocV2): string {
  const culprit = script.characters.find((c) => c.id === script.truth.culpritId);
  return `【可以宣读的真相】
真凶：${culprit?.name ?? script.truth.culpritId}
手法：${methodText(script)}
完整时间线：${fullTimelineText(script)}
关键证据：${keyEvidenceNames(script).join("、")}
复盘底稿：${revealText(script)}`;
}

/** DM：system 只放公开信息（整局不变，供前缀缓存）；真相仅在复盘任务的尾部出现。 */
export function buildDmContext(
  script: ScriptDocV2,
  state: GameState,
  events: EngineEvent[],
  opts: { task: string; requireJson?: string; recall?: string }
): PromptAssembly {
  const system = `你是一场剧本杀游戏的主持人（DM），剧本为《${script.meta.title}》。你只根据公开记录控场和渲染氛围。

【公开背景】
${narrativeToText(script.background)}

【在场人物（仅公开身份）】
${publicRoster(script, state)}

【可搜证地点】${locationNames(script).join("、")}`;

  // 近因区：与玩家侧同理，行为禁令与格式腔调贴紧生成点。
  const hardTail = `复盘前严禁：说出或暗示谁是真凶、点名该怀疑谁、引导投票、复述未公开线索原文、泄露任何角色的秘密。不要给玩家「正确答案」。
【发言要求】中文，主持人旁白口吻，100-300 字（除非另有说明）。`;

  const clueStatus = script.clues
    .map((c) => {
      const st = state.clueStates[c.id];
      if (st?.isPublic) return `· ${c.name}：已公开`;
      if (st?.discoveredBy != null) return `· ${c.name}：已被发现、未公开`;
      return `· ${c.name}：未发现`;
    })
    .join("\n");

  const growingLog = `【现场记录】
${renderLogWithMemory(events, null, state.memory, false)}`;

  const segments = {
    system,
    log: growingLog,
    anchoredHead: `【当前局面】${state.phase} 第${state.round}轮${state.turnSeat != null ? ` 轮到座位${state.turnSeat + 1}` : ""}
【线索公开状态】
${clueStatus}
${hostGuideBlock(script, state).trim()}`,
    droppable: [opts.recall?.trim() ?? ""],
    anchoredTail: `${isRevealPhase(state) ? `${truthBrief(script)}\n` : "【控场】你没有上帝视角，不要补写未公开的案情。"}
【你的任务】${opts.task}
${hardTail}${opts.requireJson ? `\n\n${opts.requireJson}` : ""}`,
  };
  return { messages: composeSegments(segments), segments };
}

/** DM 手册：分阶段提示 + 扶车指南（仅在讨论阶段注入，防卡关） */
function hostGuideBlock(script: ScriptDocV2, state: GameState): string {
  const guide = script.hostGuide;
  if (!guide) return "";
  const parts: string[] = [];
  const phaseNotes = guide.perPhase.filter((p) => p.phase === state.phase).map((p) => p.notes);
  if (phaseNotes.length) parts.push(`【主持人手册·本阶段】\n${phaseNotes.map((n) => `· ${n}`).join("\n")}`);
  if (state.phase === "DISCUSSION" && guide.stallBreakers.length) {
    parts.push(`【扶车指南（仅当讨论明显停滞时才可使用）】\n${guide.stallBreakers.map((s) => `· 若${s.condition}：${s.hint}`).join("\n")}`);
  }
  return parts.length ? `\n${parts.join("\n")}\n` : "";
}

export const GENERATOR_SYSTEM = `你是资深剧本杀作者。只输出 JSON，不要 markdown、解释或代码围栏。`;
