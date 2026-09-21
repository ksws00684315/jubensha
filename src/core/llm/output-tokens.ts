/** 绑定未填时的单次最大输出 token（含思考）。不是上下文窗口。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
/** 设置页允许的上限，对齐常见推理模型的 max_completion_tokens，避免把 1M 上下文误填成输出。 */
export const MAX_BINDING_OUTPUT_TOKENS = 131072;
export const MIN_BINDING_OUTPUT_TOKENS = 256;

export function resolveMaxOutputTokens(bindingMax: number | null | undefined, callMax?: number): number {
  const n = bindingMax ?? callMax ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(MAX_BINDING_OUTPUT_TOKENS, Math.max(MIN_BINDING_OUTPUT_TOKENS, Math.trunc(n)));
}

export function emptyCompletionError(completionTokens: number): Error {
  return new Error(
    completionTokens > 0 ? "模型返回空正文（思考过程可能占满了输出额度）" : "模型返回空正文"
  );
}

export function isRetryableLlmError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNRESET|ECONNREFUSED|fetch failed|network|socket|502|503|504|429|rate.?limit|overloaded|空正文|unknown.?param|unrecognized|unexpected.?field/i.test(
    msg
  );
}

/**
 * provider 的内容审核以"助手口吻拒绝"形式回报文（而非 HTTP 故障）。
 * 只用于识别错误报文，不去扫正常正文——角色自己说"我很抱歉"是剧本里的常态。
 */
const SAFETY_REFUSAL =
  /无法提供相应的信息|无法回答这(个|一)问题|无法为(您|你)(提供|回答)|抱歉，?(我)?(无法|不能)(提供|回答|帮助|讨论)|很抱歉[，,]?(我)?(无法|不能)|作为(一个)?(AI|人工智能|语言模型)|(I'?m|I am)\s+sorry|can'?t\s+(help|assist|answer|provide)|unable\s+to\s+(help|answer|provide|discuss)|as an AI language model|content policy/i;

export function isSafetyRefusal(err: unknown): boolean {
  return SAFETY_REFUSAL.test(err instanceof Error ? err.message : String(err));
}

/**
 * 内容审核除了报错（TEXT_AUDIT_ANSWER_NOT_PASS），也可能把拒绝话术当正文交回来，
 * 所以台词层要单独判一次。判定从严：自称 AI，或「拒绝动词＋客服式收尾」同时出现——
 * 角色自己说「抱歉，我不能提供他的住处」是正常台词，不能误判。
 */
const AI_SELF = /作为\s*(AI|人工智能|语言模型)|as an AI( language model)?|(I'?m|I am)\s+sorry,?\s+but|(I )?can'?t\s+(help|assist|provide|answer)|unable to (assist|answer|provide)|content policy/i;
const CANNED_REFUSAL = /(无法|不能|没法)(提供|回答|讨论|解答|透露)/;
const CANNED_CLOSING = /(相应的信息|相关的?(信息|内容|帮助)|其他(问题|需要|疑问)|更多(信息|帮助|内容)|安全(策略|规定|准则)|很(愿意|乐意)(为)?(您|你)?(回答|服务|帮助|解答))/;

export function isRefusalBoilerplate(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 160) return false;
  if (AI_SELF.test(t)) return true;
  return CANNED_REFUSAL.test(t) && CANNED_CLOSING.test(t);
}
