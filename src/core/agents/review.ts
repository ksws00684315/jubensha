/**
 * ★ 二次审查 ★（借鉴 AI Alibis 的 critique→refine：不指望单次 prompt 约住模型，
 * 生成后用机器可判的启发式筛出可疑发言，再交一次廉价 LLM 判定并做最小修改。）
 *
 * 守卫（guard.ts）负责"泄露"这种硬红线；本模块负责两类软问题：
 *  - 出戏：台词里冒出 AI/助手/剧本杀机制等元话语；
 *  - 复读：和该角色上一段发言开头几乎一样。
 * 只有启发式命中才触发审查调用（成本近零）；审查器只做最小修改、保持原意与人设。
 */

import type { EngineEvent, Phase, PlayerActionPlan } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

/** 出戏元话语标记：角色嘴里不该出现的词 */
const OOC_PATTERN =
  /(人工智能|语言模型|大模型|提示词|系统提示|系统消息|剧本杀|回合制|游戏机制|角色卡|舞台指示|(^|[^a-zA-Z])AI([^a-zA-Z]|$)|(^|[^a-zA-Z])NPC([^a-zA-Z]|$))/i;

/** 判定一段发言是否值得送审 */
export function shouldReviewSpeech(text: string, ownLastSpeech: string | null): boolean {
  if (!text.trim()) return false;
  if (OOC_PATTERN.test(text)) return true;
  if (ownLastSpeech && firstTokens(text) === firstTokens(ownLastSpeech)) return true;
  return false;
}

/** 取该座位最近一次公开发言（用于复读判定；不含当前未记录的这次） */
export function lastOwnSpeechText(events: Array<{ type: string; fromSeat: number | null; content: { text?: string } }>, seatIndex: number): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "speech" && ev.fromSeat === seatIndex && ev.content.text) return ev.content.text;
  }
  return null;
}

/** 开头归一化（忽略标点与空白），取前 8 个有效字符做复读比对 */
function firstTokens(text: string): string {
  return text.replace(/[，。；：、！？\s""''（）()]/g, "").slice(0, 8);
}

/** 「这段台词相对于已发生的那段发言是否带了新料」的判据，见 makeNoveltyJudge */
export interface NoveltyJudge {
  /** 有没有资格判定新旧：判据缺失时不可判，此时一律不降级（宁可留冗余，不吞掉发言） */
  judgeable: boolean;
  novelVs: (candidate: string, prior: EngineEvent) => boolean;
}

/**
 * 「有新证据」以场上事实为准，而不是只信模型自报的 focusEvidenceIds：
 * 行动计划里这个字段约一半是空的（模型漏写），只按它豁免会让本地启发式
 * 把「换了说法的实质推进」一律判成复读，兜底出一堆「我同意已有的判断」。
 * 这里补一条独立来源——本轮新公开的线索——台词点名引用了别人没引用过的，即算新料。
 */
export function makeNoveltyJudge(script: ScriptDocV2, events: EngineEvent[], phase: Phase, round: number, declaredIds: string[]): NoveltyJudge {
  const freshIds = [...new Set(events.filter((ev) => ev.type === "clue" && ev.visibility === "public" && ev.phase === phase && ev.round === round).map((ev) => String(ev.content.clueId ?? "")).filter(Boolean))];
  const names = new Map(freshIds.map((id) => [id, script.clues.find((clue) => clue.id === id)?.name ?? ""]));
  const cited = (text: string) => freshIds.filter((id) => { const name = names.get(id) ?? ""; return name.length >= 2 && text.includes(name); });
  return {
    judgeable: freshIds.length > 0 || declaredIds.length > 0,
    novelVs: (candidate, prior) => {
      const priorText = String(prior.content.text ?? "");
      const priorRefs = new Set([...cited(priorText), ...(Array.isArray(prior.content.focusEvidenceIds) ? prior.content.focusEvidenceIds : [])]);
      return cited(candidate).some((id) => !priorRefs.has(id)) || declaredIds.some((id) => !priorRefs.has(id));
    },
  };
}

/**
 * 确实要降级时给一句该座位自己的短话：全场共用同一句话会在多座位同时命中时
 * 产出字字相同的空话（比复读更难看），按本轮意图与回应对象分流。
 */
export function degradedSpeechLine(plan: PlayerActionPlan | undefined, targetName: string | null): string {
  const target = targetName ? `等${targetName}接话` : "等有人接话";
  switch (plan?.nextAction) {
    case "ask":
      return `这一点我刚才说过了，先把问题抛出去，${target}。`;
    case "defend":
      return "我的说法没有改动，也不会改。";
    case "probe":
      return "我这话已经说明白了，先看看对方怎么接。";
    case "exchange":
      return "剩下的我先收着，私下对完再拿到台面上。";
    case "wait":
      return "这一轮我不再添话了。";
    default:
      return "前面那条我已经说清楚了，这里不重复。";
  }
}
