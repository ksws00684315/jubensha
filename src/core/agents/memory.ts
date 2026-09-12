import type { ChatMessage } from "@/core/llm/types";
import type { EngineEvent, GameState } from "@/core/engine/types";
import { renderEventLog, visibleTo } from "@/core/engine/state";
import type { ClueV2, ScriptDocV2 } from "@/core/script/v2/schema";

/**
 * ★ 分层记忆 ★
 * 借鉴 SillyTavern Summarize（滚动摘要）、AI Dungeon Story Summary（近期原文窗口永不摘要）、
 * Character.AI Facts（事实条目式概要）：
 *  - 原文窗口：最近 RECENT_WINDOW_CHARS 字符的事件逐字保留（玩家刚说的话永远原文可见）；
 *  - 滚动摘要：窗口之前的「公共」事件由 LLM 压成一份概要，锚定在 anchorSeq；
 *  - 摘要是全场公共视角，不包含任何座位的私密事件（防火墙不变式）；
 *    玩家自己的私密情报始终逐字出现在其上下文尾部【你持有的线索卡】，不会因摘要丢失。
 * 代价与策略：摘要文本位于 prompt 用户消息开头，更新一次即全场缓存失效一次；
 * 引擎因此把更新锚定在轮次边界（transitionSearch/transitionDiscussion），轮内前缀稳定。
 */

/** 逐字保留的近期窗口大小（按渲染后字符数估算） */
export const RECENT_WINDOW_CHARS = 6000;
/** 近期窗口至少保留的事件条数（防止窗口内全是短事件时把关键发言切进摘要） */
export const MIN_RECENT_EVENTS = 8;
/** 摘要锚点之后新增内容超过该字符数才值得再调一次 LLM 更新摘要 */
export const SUMMARY_TRIGGER_CHARS = 2500;

export interface MemoryPlan {
  /** 等待被摘要的公共事件前缀 */
  head: EngineEvent[];
  /** 逐字保留的近期窗口（含所有可见事件） */
  tail: EngineEvent[];
}

/** 按公共视角决定摘要切分点：从尾部往前累计，超出窗口预算即停止。 */
export function planMemorySplit(events: EngineEvent[]): MemoryPlan {
  let acc = 0;
  let count = 0;
  let boundary = 0;
  for (let j = events.length - 1; j >= 0; j--) {
    const ev = events[j];
    if (visibleTo(ev, null)) {
      acc += renderEventLog([ev], null).length + 1;
      count++;
    }
    if (acc >= RECENT_WINDOW_CHARS && count >= MIN_RECENT_EVENTS) {
      boundary = j;
      break;
    }
  }
  return { head: events.slice(0, boundary), tail: events.slice(boundary) };
}

/** 摘要锚点之后、尚待纳入摘要的公共事件字符数（引擎用它决定是否触发一次摘要更新） */
export function pendingHeadChars(events: EngineEvent[], anchorSeq: string): number {
  const { head } = planMemorySplit(events);
  const idx = anchorSeq ? head.findIndex((e) => e.seq === anchorSeq) : -1;
  const pending = idx >= 0 ? head.slice(idx + 1) : head;
  return renderEventLog(pending, null).length;
}

/**
 * 带滚动记忆的事件日志渲染：
 *  - 有有效锚点 →【此前概要】+【最近的现场记录】（锚点之后逐字）；
 *  - 锚点缺失/落后到无法衔接/无记忆 → 退回全量日志（永远正确，只是更贵）。
 */
export function renderLogWithMemory(
  events: EngineEvent[],
  seatIndex: number | null,
  memory: GameState["memory"],
  includePrivate: boolean
): string {
  if (!memory?.summary || !memory.anchorSeq) {
    return renderEventLog(events, seatIndex, { includePrivate });
  }
  const anchorIdx = events.findIndex((e) => e.seq === memory.anchorSeq);
  if (anchorIdx < 0) {
    return renderEventLog(events, seatIndex, { includePrivate });
  }
  // 座位视角:锚点之前的「非公开且属于自己」事件(私聊/转交/私发提示)不进摘要,
  // 原样保留为私密备忘——公共摘要只压缩公共历史,绝不吃掉玩家的私密记忆。
  let privateMemo = "";
  if (seatIndex !== null) {
    const memoLines = renderEventLog(
      events
        .slice(0, anchorIdx + 1)
        .filter((e) => visibleTo(e, seatIndex) && e.visibility !== "public" && e.type !== "clue"),
      seatIndex,
      { includePrivate: true },
    );
    if (memoLines.trim()) privateMemo = `\n\n【此前的私密备忘（仅你可见，仍然有效）】\n${memoLines}`;
  }

  const recent = renderEventLog(events.slice(anchorIdx + 1), seatIndex, { includePrivate });
  if (!recent.trim()) {
    return `【现场记录·此前概要】\n${memory.summary.trim()}${privateMemo}`;
  }
  return `【现场记录·此前概要】\n${memory.summary.trim()}${privateMemo}\n\n【最近的现场记录】\n${recent}`;
}

/** 摘要员 prompt：把（旧摘要 + 新增记录）合并成一份事实条目式概要。 */
export function buildSummarizeMessages(prevSummary: string, headLog: string): ChatMessage[] {
  const system = `你是一场剧本杀对局的记录员，负责把现场记录压缩成供后续推理使用的概要。要求：
- 只依据记录原文，不要推测、不要补写案情，不要指认谁是真凶。
- 用简短条目保留：每个人的关键陈述与相互矛盾之处、已公开的线索及其要点、谁指控了谁与回应、尚未解决的疑点。
- 总长不超过 500 字。只输出概要正文，不要标题、解释或代码围栏。`;
  const user = `${
    prevSummary
      ? `【已有概要（在其基础上续写合并，不要丢失仍然有效的信息，已过时或被推翻的内容可删去）】\n${prevSummary}\n\n`
      : ""
  }【需要压缩合并的现场记录】\n${headLog}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 扫描最近多少条发言来发现「讨论提到了你手里的线索」 */
const MENTION_SCAN_EVENTS = 12;

/**
 * ★ 世界书思路的轻量适配 ★（SillyTavern World Info：被提及才注入）
 * 最近别人发言提到「我持有的私藏线索」的名字时，返回这些线索名，
 * 上下文尾部会据此提示玩家可以在合适的时机打出这张牌——
 * 解决 AI 玩家手里攥着关键线索却不知道什么时候该说的老问题。
 */
export function clueMentionHints(
  script: ScriptDocV2,
  state: GameState,
  seatIndex: number,
  events: EngineEvent[]
): string[] {
  const held = (state.heldClues[seatIndex] ?? [])
    .map((id) => script.clues.find((c) => c.id === id))
    .filter((c): c is ClueV2 => Boolean(c) && state.clueStates[c!.id]?.isPublic !== true);
  if (!held.length) return [];
  const recentSpeech = events.filter((e) => e.type === "speech" && visibleTo(e, seatIndex)).slice(-MENTION_SCAN_EVENTS);
  const hints: string[] = [];
  for (const clue of held) {
    const mentionedByOther = recentSpeech.some(
      (e) => e.fromSeat !== seatIndex && typeof e.content.text === "string" && e.content.text.includes(clue.name)
    );
    if (mentionedByOther) hints.push(clue.name);
  }
  return hints;
}
