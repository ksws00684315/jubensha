import { describe, expect, it } from "vitest";
import { embeddingSpaceId, estimateInputTokens, fitMessagesToInputBudget, inputBudgetTokens } from "./client";

describe("LLM 上下文与 embedding 空间", () => {
  it("用保守估算拒绝把中文字符直接当作 token", () => {
    expect(estimateInputTokens([{ content: "a".repeat(350) }])).toBe(100);
    expect(estimateInputTokens([{ content: "你好".repeat(350) }])).toBe(200);
  });

  it("模型或端点变化会产生不同的 embedding 空间", () => {
    const base = { providerId: "p1", baseUrl: "https://example.test/v1", modelId: "embed-a" } as const;
    expect(embeddingSpaceId(base)).toBe(embeddingSpaceId(base));
    expect(embeddingSpaceId({ ...base, modelId: "embed-b" })).not.toBe(embeddingSpaceId(base));
    expect(embeddingSpaceId({ ...base, baseUrl: "https://other.test/v1" })).not.toBe(embeddingSpaceId(base));
  });

  it("按上下文窗口预留输出和安全余量，未配置窗口时不猜测", () => {
    expect(inputBudgetTokens({ contextWindow: 8_000 }, 1_000)).toBe(6_600);
    expect(inputBudgetTokens({ contextWindow: null }, 1_000)).toBeNull();
    expect(inputBudgetTokens({ contextWindow: 512 }, 1_000)).toBe(0);
  });

  it("预算不足时只裁剪最旧现场记录，保留当前线索与任务尾部", () => {
    const messages = [
      { role: "system" as const, content: "固定规则" },
      { role: "user" as const, content: `【到目前为止的现场记录】\n${"很早的发言。".repeat(2_000)}\n\n【你持有的线索卡】\n线索全文\n\n当前任务：回答问题` },
    ];
    const fitted = fitMessagesToInputBudget({ contextWindow: 2_000 }, messages, 512);
    expect(fitted[0].content).toBe(messages[0].content);
    expect(fitted[1].content).toContain("线索全文");
    expect(fitted[1].content).toContain("当前任务：回答问题");
    expect(fitted[1].content).toContain("较早现场记录因模型输入预算已裁剪");
  });
});
