import { describe, expect, it } from "vitest";
import { embeddingSpaceId, estimateInputTokens, fitSegmentsToInputBudget, inputBudgetTokens } from "./client";
import { composeSegments, type PromptSegments } from "./prompt-segments";

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

  it("预算不足时先裁最旧现场记录，保留线索卡与任务尾部", () => {
    const segments: PromptSegments = {
      system: "固定规则",
      log: `【到目前为止的现场记录】\n${"很早的发言。".repeat(2_000)}结尾的发言。`,
      anchoredHead: "【你持有的线索卡】\n线索全文",
      droppable: [],
      anchoredTail: "当前任务：回答问题",
    };
    const fitted = fitSegmentsToInputBudget({ contextWindow: 2_000 }, segments, 512);
    const user = composeSegments(fitted)[1].content;
    expect(fitted.system).toBe(segments.system);
    expect(user).toContain("线索全文");
    expect(user).toContain("当前任务：回答问题");
    expect(user).toContain("结尾的发言。");
    expect(user).toContain("较早现场记录因模型输入预算已裁剪");
    expect(estimateInputTokens(composeSegments(fitted))).toBeLessThanOrEqual(inputBudgetTokens({ contextWindow: 2_000 }, 512)!);
  });

  it("三档降级：充裕原样返回 → 按序丢 droppable → anchored 超载时原样交断言层", () => {
    const base: PromptSegments = {
      system: "固定规则",
      log: "短记录",
      anchoredHead: "【你持有的线索卡】\n线索全文",
      droppable: ["R".repeat(3_000), "P".repeat(3_000), "M".repeat(3_000)],
      anchoredTail: "【发言要求】与当前任务",
    };
    // 未配置窗口：整段跳过
    expect(fitSegmentsToInputBudget({ contextWindow: null }, base, 512)).toBe(base);
    // 充裕：一份不动（原对象引用）
    const roomy = fitSegmentsToInputBudget({ contextWindow: 200_000 }, base, 512);
    expect(roomy.droppable).toHaveLength(3);
    // 3.5 字符≈1 token：droppable 三块合计约 2571，两块约 1713，一块约 857
    // 窗口 5000→预算 4232：全放得下（log 极短，不动第一档）
    expect(fitSegmentsToInputBudget({ contextWindow: 5_000 }, base, 512).droppable).toHaveLength(3);
    // 窗口 3000→预算 2238：丢第 1 个（R）后约 1726 可容纳
    const one = fitSegmentsToInputBudget({ contextWindow: 3_000 }, base, 512);
    expect(one.droppable).toEqual(["P".repeat(3_000), "M".repeat(3_000)]);
    // 窗口 2000→预算 1232：丢到只剩最后一个（M 档需 869）
    const two = fitSegmentsToInputBudget({ contextWindow: 2_000 }, base, 512);
    expect(two.droppable).toEqual(["M".repeat(3_000)]);
    // 窗口 1000→预算 232：droppable 按序全部丢光
    const three = fitSegmentsToInputBudget({ contextWindow: 1_000 }, base, 512);
    expect(three.droppable).toEqual([]);
  });

  it("锚定区自身超载时不裁不丢，原样交断言层抛错", () => {
    const heavy: PromptSegments = {
      system: "固定规则",
      log: "短记录",
      anchoredHead: "【你持有的线索卡】\n" + "线".repeat(10_000),
      droppable: ["【召回】\n" + "R".repeat(3_000)],
      anchoredTail: "【发言要求】与当前任务",
    };
    const fitted = fitSegmentsToInputBudget({ contextWindow: 2_000 }, heavy, 512);
    // droppable 丢光、锚定区一字不动——超出部分由 assertContextBudget 显式报错
    expect(fitted.droppable).toEqual([]);
    expect(fitted.anchoredHead).toBe(heavy.anchoredHead);
    expect(estimateInputTokens(composeSegments(fitted))).toBeGreaterThan(inputBudgetTokens({ contextWindow: 2_000 }, 512)!);
  });
});
