import type { ChatMessage } from "@/core/llm/types";
import type { EngineEvent, GameState } from "@/core/engine/types";
import { renderEventLog } from "@/core/engine/state";
import type { ScriptDoc } from "@/core/script/schema";

/**
 * ★ 信息防火墙 ★
 * 任何 AI 的 prompt 只能经由本文件构建。规则：
 *  - 玩家 agent：只能拿到「公共事件流 + 自己的角色卡 + 自己持有的线索 + 与自己相关的私聊」。
 *    truth 与其他座位的角色卡/线索在本文件中就不可达（类型与代码路径双重隔离）。
 *  - DM agent：看得到完整剧本，但 DM 的输出只作为系统/旁白消息，不参与投票。
 *
 * ★ 前缀缓存 ★
 * 所有 LLM 消息都走 cacheFriendlyMessages：system 整局不变；user = 只增不改的现场记录 + 每轮才变的尾部。
 */

export function seatOf(state: GameState, seatIndex: number) {
  return state.seats[seatIndex];
}

export function characterOf(script: ScriptDoc, state: GameState, seatIndex: number) {
  const seat = seatOf(state, seatIndex);
  return script.characters.find((c) => c.id === seat.characterId);
}

export function heldCluesOf(script: ScriptDoc, state: GameState, seatIndex: number) {
  return (state.heldClues[seatIndex] ?? []).map((id) => script.clues.find((c) => c.id === id)).filter(Boolean);
}

/** 稳定 system + 只追加的日志 + 每轮尾部。供前缀缓存命中。 */
export function cacheFriendlyMessages(system: string, growingLog: string, tail: string): ChatMessage[] {
  return [
    { role: "system", content: system.trim() },
    { role: "user", content: `${growingLog.trimEnd()}\n\n${tail.trim()}\n` },
  ];
}

function phaseInstruction(_script: ScriptDoc, state: GameState, _seatIndex: number, hint?: string): string {
  switch (state.phase) {
    case "SELF_INTRO":
      return `现在是【自我介绍】环节。请以第一人称做一段 80-150 字的自我介绍：你是谁、与死者的关系、今晚大致做了什么（按你的角色卡时间线，注意保护你的秘密）。不要剧透游戏机制。`;
    case "DISCUSSION":
      return `现在是【第 ${state.round} 轮圆桌讨论】。${hint ? `主持人提示：${hint}` : "请继续讨论：可以陈述你的时间线、质疑别人的说法、或说出你的推理。"}`;
    case "SEARCH":
      return `现在是【第 ${state.round} 轮搜证】。`;
    case "VOTE":
      return `现在是【投票】环节。`;
    default:
      return `当前阶段：${state.phase}（第 ${state.round} 轮）。`;
  }
}

function publicRoster(script: ScriptDoc, state: GameState): string {
  return state.seats
    .filter((s) => s.kind !== "empty")
    .map((s) => {
      const c = script.characters.find((ch) => ch.id === s.characterId);
      return `· 座位${s.index + 1} ${s.kind === "ai" ? "AI" : "真人"} ${s.playerName}${c ? ` 公开身份：${c.name}，${c.publicBio}` : ""}`;
    })
    .join("\n");
}

/** 玩家 agent 的完整上下文（防火墙出口） */
export function buildPlayerContext(
  script: ScriptDoc,
  state: GameState,
  seatIndex: number,
  events: EngineEvent[],
  opts: { hint?: string; extraInstruction?: string; requireJson?: string }
): ChatMessage[] {
  const character = characterOf(script, state, seatIndex);
  if (!character) throw new Error(`座位 ${seatIndex} 未绑定角色`);

  const isCulprit = character.card.isCulprit;
  const clues = heldCluesOf(script, state, seatIndex);
  const publicClues = clues.filter((c) => c && state.clueStates[c.id]?.isPublic);

  const strategy = isCulprit
    ? `【你的处境】你就是真凶。你的首要目标是活过今晚：绝不能承认、绝不能供出手法细节。
- 坚守你的角色卡时间线（对时间线的叙述以你的角色卡为准，可以合理省略，但不要与卡片记录硬冲突）。
- 当有线索指向你时，用职业/性格上说得通的解释带过，并自然地把讨论引向其他人（有动机、有秘密的人）。
- 不要撒连自己都记不住的谎；少说细节，多反问。
- 你的一切发言都在伪造的"好人"身份下进行，语气要符合你的人设。`
    : `【你的处境】你是无辜者之一。你的目标是找出真凶并让大家相信你。
- 基于公开信息与你自己掌握的线索推理，敢于质疑别人的时间线漏洞。
- 保护好你自己的秘密（每个角色都有不可告人之事），被逼问时可以回避或部分承认，但不要撒与案件时间线有关的硬谎。
- 该亮出对你有利的线索时果断亮出。`;

  const system = `你正在参加一场文字剧本杀游戏《${script.meta.title}》，扮演其中一名角色。全程以第一人称、在戏内说话。

【公开背景】
${script.background}

【在场人物（仅公开身份）】
${publicRoster(script, state)}

【可搜证地点】${script.locations.join("、")}

【你的角色】${character.name}${character.gender ? `（${character.gender}）` : ""}${character.age ? ` ${character.age} 岁` : ""}
公开身份：${character.publicBio}
角色背景：${character.card.backstory}
你的秘密（绝不能主动告诉任何人）：${character.card.secret}
你的目标：${character.card.goal}
你的时间线（你自己的经历，可按此陈述）：${character.card.timeline}
你额外知道的事：${character.card.knowledge.map((k) => `· ${k}`).join("\n") || "（无）"}
你的说话风格：${character.card.persona}

${strategy}

【发言要求】
- 每次发言 60-180 字，中文，口语化，符合人设。不要输出任何舞台指示、括号动作或"我说"之类的前缀。
- 你看到的【线索·仅你可见】是你自己的情报，可以转述其中的内容（视为你亲手翻到的），但请用你的口吻，不要逐字念卡。
- 除你持有的线索外，你不知道任何未公开的信息；其他玩家说的都是他们的陈述，真假自辨。`;

  const clueBlock =
    clues.length === 0
      ? "（暂无）"
      : clues.map((c) => `· ${c!.name}（${publicClues.includes(c!) ? "已公开" : "仅你可见"}）: ${c!.content}`).join("\n");

  const growingLog = `【到目前为止的现场记录】
${renderEventLog(events, seatIndex, { includePrivate: true })}`;

  const tail = `【你持有的线索卡】
${clueBlock}

${phaseInstruction(script, state, seatIndex, opts.hint)}
${opts.extraInstruction ?? ""}
${opts.requireJson ? `\n${opts.requireJson}` : ""}`;

  return cacheFriendlyMessages(system, growingLog, tail);
}

/** DM agent：system 放完整剧本（整局不变）；现场记录只追加；任务/线索状态放尾部。 */
export function buildDmContext(
  script: ScriptDoc,
  state: GameState,
  events: EngineEvent[],
  opts: { task: string; requireJson?: string }
): ChatMessage[] {
  const seatLines = state.seats
    .filter((s) => s.kind !== "empty")
    .map((s) => {
      const c = script.characters.find((ch) => ch.id === s.characterId);
      const card = c
        ? `秘密：${c.card.secret}；目标：${c.card.goal}；时间线：${c.card.timeline}${c.card.isCulprit ? "（真凶）" : ""}`
        : "";
      return `· 座位${s.index + 1} ${s.kind === "ai" ? "[AI]" : "[真人]"} ${s.playerName} 扮演 ${c?.name ?? "?"}。${card}`;
    })
    .join("\n");

  const clueCatalog = script.clues
    .map((c) => `· [${c.location}] ${c.name}（${c.policy}）：${c.content}`)
    .join("\n");

  const culprit = script.characters.find((c) => c.id === script.truth.culprit);

  const system = `你是一场剧本杀游戏的主持人（DM），剧本为《${script.meta.title}》。你的话要保持"主持人"身份：不引导投票倾向。复盘前旁白严禁出现真凶姓名、作案手法细节、未公开线索原文。

【公开背景】
${script.background}

【仅你可见的真相，旁白中禁止说出（复盘任务除外）】
真凶：${culprit?.name ?? script.truth.culprit}
手法：${script.truth.method}
完整时间线：${script.truth.fullTimeline}
关键证据：${script.truth.keyEvidence.join("、")}
复盘底稿：${script.truth.reveal}

【各座位与角色卡】
${seatLines}

【全部线索原文】
${clueCatalog}

【发言要求】中文，符合主持人身份的旁白口吻，100-300 字（除非另有说明）。`;

  const clueStatus = script.clues
    .map((c) => {
      const st = state.clueStates[c.id];
      if (st?.isPublic) return `· ${c.name}：已公开`;
      if (st?.discoveredBy != null) return `· ${c.name}：座位${st.discoveredBy + 1}持有、未公开`;
      return `· ${c.name}：未发现`;
    })
    .join("\n");

  const growingLog = `【现场记录】
${renderEventLog(events, null)}`;

  const tail = `【当前局面】${state.phase} 第${state.round}轮${state.turnSeat != null ? ` 轮到座位${state.turnSeat + 1}` : ""}
【线索状态】
${clueStatus}

【你的任务】${opts.task}
${opts.requireJson ? opts.requireJson : ""}`;

  return cacheFriendlyMessages(system, growingLog, tail);
}

export const GENERATOR_SYSTEM = `你是资深剧本杀作者。只输出 JSON，不要 markdown、解释或代码围栏。`;
