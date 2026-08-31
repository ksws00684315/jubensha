import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  emptyCompletionError,
  isRetryableLlmError,
  MAX_BINDING_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from "./output-tokens";

describe("resolveMaxOutputTokens", () => {
  it("绑定优先于调用方上限", () => {
    expect(resolveMaxOutputTokens(65536, 500)).toBe(65536);
  });

  it("未绑定则用调用方，再退回默认", () => {
    expect(resolveMaxOutputTokens(null, 1024)).toBe(1024);
    expect(resolveMaxOutputTokens(undefined)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("夹在最小值与 131072，避免把 1M 上下文写成输出", () => {
    expect(resolveMaxOutputTokens(1_000_000)).toBe(MAX_BINDING_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(10)).toBe(256);
  });
});

describe("emptyCompletionError", () => {
  it("有 completion 仍无正文时视为思考占满额度，且可重试", () => {
    const err = emptyCompletionError(500);
    expect(err.message).toContain("思考过程");
    expect(isRetryableLlmError(err)).toBe(true);
  });
});
