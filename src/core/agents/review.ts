/**
 * ★ 二次审查 ★（借鉴 AI Alibis 的 critique→refine：不指望单次 prompt 约住模型，
 * 生成后用机器可判的启发式筛出可疑发言，再交一次廉价 LLM 判定并做最小修改。）
 *
 * 守卫（guard.ts）负责"泄露"这种硬红线；本模块负责两类软问题：
 *  - 出戏：台词里冒出 AI/助手/剧本杀机制等元话语；
 *  - 复读：和该角色上一段发言开头几乎一样。
 * 只有启发式命中才触发审查调用（成本近零）；审查器只做最小修改、保持原意与人设。
 */

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
