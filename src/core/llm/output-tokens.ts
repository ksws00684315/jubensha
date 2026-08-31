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
