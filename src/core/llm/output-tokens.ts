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
