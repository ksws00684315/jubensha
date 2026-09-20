import type { ChatMessage, PromptSegments } from "./types";

export type { PromptSegments, PromptAssembly } from "./types";

/**
 * ★ 分层上下文预算 ★
 * Prompt 不再是一整块字符串，而是按「降级代价」分档的结构（见 types.ts PromptSegments）：
 *  - system       整局不变的角色卡/规则（前缀缓存锚点）
 *  - log          只追加的现场记录 —— 降级第一档：裁最旧、保最近
 *  - anchoredHead 紧邻 log 的固定块（线索卡/当前局面），逐轮语义连续，不裁不丢
 *  - droppable    锦上添花的注入块（召回、公开证据登记、可打出的牌），
 *                 降级第二档：按「先丢→后丢」的数组顺序整块丢弃
 *  - anchoredTail 阶段指令、近因区硬约束、格式指令 —— 永不降级
 * 结构仍走 cacheFriendlyMessages 的拼接次序，前缀缓存不变式不受影响；
 * 预算裁剪从「硬编码字符串标记定位」变成对分段本身的确定性操作。
 */

/** 与 cacheFriendlyMessages 同构：system + (log + "\n\n" + tail)，tail 内各块以空行分隔。 */
export function composeSegments(s: PromptSegments): ChatMessage[] {
  const tail = [s.anchoredHead, ...s.droppable.filter((b) => b.trim()), s.anchoredTail]
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .join("\n\n");
  return [
    { role: "system", content: s.system.trim() },
    { role: "user", content: `${s.log.trimEnd()}\n\n${tail}\n` },
  ];
}
