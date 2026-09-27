import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S3.2 每日 LLM token 预算熔断。
 *
 * db 与 ai SDK 全部 mock：这里要证明的是「什么时候查库、什么时候放行」，
 * 以及熔断发生时一次模型请求都不该发出。
 */
const h = vi.hoisted(() => ({
  aggregate: vi.fn(),
  logs: [] as Array<Record<string, unknown>>,
  bindingLookups: 0,
  modelCalls: { generateText: 0, streamText: 0 },
  binding: {
    id: "b1",
    providerId: "p1",
    modelId: "m1",
    supportsSystem: true,
    supportsJson: false,
    detectedSystemSupport: true,
    provider: { id: "p1", enabled: true, name: "mock", baseUrl: "https://mock.test/v1", protocol: "openai_compatible", apiKeyCipher: "cipher" },
  },
}));

vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "test" }));
vi.mock("@/lib/db", () => ({
  db: {
    modelBinding: {
      findUnique: async () => {
        h.bindingLookups += 1;
        return h.binding;
      },
      updateMany: async () => undefined,
    },
    usageLog: {
      aggregate: h.aggregate,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.logs.push(data);
      },
    },
  },
}));
vi.mock("ai", () => ({
  generateText: async () => {
    h.modelCalls.generateText += 1;
    return { text: "正常台词", usage: { promptTokens: 5, completionTokens: 2 } };
  },
  streamText: () => {
    h.modelCalls.streamText += 1;
    return {
      textStream: (async function* () {
        yield "正常台词";
      })(),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2 }),
    };
  },
}));

const opts = { purpose: "player" as const, messages: [{ role: "user" as const, content: "说点什么" }] };

async function budgetModule() {
  return import("./budget");
}

function sumOf(total: number) {
  return { _sum: { totalTokens: total } };
}

beforeEach(() => {
  h.aggregate.mockReset();
  h.logs.length = 0;
  h.bindingLookups = 0;
  h.modelCalls.generateText = 0;
  h.modelCalls.streamText = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("S3.2 预算计算与缓存", () => {
  it("预算为 0 / 未设置 / 非法值一律视为关闭，且关闭时一次库都不查", async () => {
    const { assertWithinBudget, dailyTokenBudget, resetBudgetCache } = await budgetModule();
    for (const raw of [undefined, "", "0", "abc", "-5", "  "]) {
      resetBudgetCache();
      vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", raw as string);
      expect(dailyTokenBudget()).toBe(0);
      await expect(assertWithinBudget("player")).resolves.toBeUndefined();
    }
    expect(h.aggregate).not.toHaveBeenCalled();
  });

  it("60s 内复用缓存只查一次，超过 60s 才重新查", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 10, 0, 0));
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const { assertWithinBudget, resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(400));
    for (let i = 0; i < 5; i++) await assertWithinBudget("player");
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    await assertWithinBudget("player");
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertWithinBudget("player");
    expect(h.aggregate).toHaveBeenCalledTimes(2);
  });

  it("合计达到预算即拦（≥），差一点仍放行", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const { assertWithinBudget, BudgetExceededError, resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(999));
    await expect(assertWithinBudget("player")).resolves.toBeUndefined();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(1000));
    await expect(assertWithinBudget("player")).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("按服务器本地时区的当天 00:00 起算", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 0));
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const { assertWithinBudget, startOfLocalDay, resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(0));
    await assertWithinBudget("player");
    expect(startOfLocalDay().getTime()).toBe(new Date(2026, 8, 27, 0, 0, 0).getTime());
    expect(h.aggregate.mock.calls[0][0]).toMatchObject({ where: { createdAt: { gte: new Date(2026, 8, 27, 0, 0, 0) } } });
  });

  it("跨到次日：缓存按天失效，重新按新的一天求和", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 23, 59, 0));
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const { assertWithinBudget, resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(5000));
    await expect(assertWithinBudget("player")).rejects.toThrow(/预算已用尽/);
    vi.setSystemTime(new Date(2026, 8, 28, 0, 1, 0));
    h.aggregate.mockResolvedValue(sumOf(0));
    await expect(assertWithinBudget("player")).resolves.toBeUndefined();
    expect(h.aggregate).toHaveBeenCalledTimes(2);
  });

  it("并发调用共用同一次查询，不放大库压力", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const { assertWithinBudget, resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    let release: (v: unknown) => void = () => {};
    h.aggregate.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = Promise.all([assertWithinBudget("player"), assertWithinBudget("dm"), assertWithinBudget("culprit")]);
    await vi.waitFor(() => expect(h.aggregate).toHaveBeenCalledTimes(1));
    release(sumOf(10));
    await expect(pending).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("求和失败时放行（不因守卫本身新增失败面），并把该结果缓存 60s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 27, 10, 0, 0));
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { assertWithinBudget, resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockRejectedValue(new Error("connection lost"));
    await expect(assertWithinBudget("player")).resolves.toBeUndefined();
    await expect(assertWithinBudget("player")).resolves.toBeUndefined();
    expect(h.aggregate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("S3.2 三个 LLM 入口的接线", () => {
  it("关闭熔断时 chat 的库调用与改动前一致（只有绑定与用量日志）", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "");
    const { resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    const { chat } = await import("./client");
    const r = await chat(opts);
    expect(r.text).toBe("正常台词");
    expect(h.aggregate).not.toHaveBeenCalled();
    expect(h.bindingLookups).toBe(1);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ ok: true, promptTokens: 5, completionTokens: 2 });
  });

  it("超预算时 chat 抛 BudgetExceededError：不发模型请求、不查绑定、不记用量", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "100");
    const { resetBudgetCache, BudgetExceededError } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(100));
    const { chat } = await import("./client");
    await expect(chat(opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.modelCalls.generateText).toBe(0);
    expect(h.bindingLookups).toBe(0);
    expect(h.logs).toHaveLength(0);
  });

  it("超预算时 chatStream 在首个 chunk 前就抛，同样零模型请求", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "100");
    const { resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(240));
    const { chatStream } = await import("./client");
    let text = "";
    await expect((async () => {
      for await (const chunk of chatStream(opts)) text += chunk;
    })()).rejects.toThrow(/预算已用尽/);
    expect(text).toBe("");
    expect(h.modelCalls.streamText).toBe(0);
  });

  it("超预算时 embedTexts 返回 null：记忆层停用而不是把异常抛进发言主流程", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "100");
    const { resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(100));
    const { embedTexts } = await import("./client");
    await expect(embedTexts(["一句台词"])).resolves.toBeNull();
  });

  it("错误文案只含用量数字（该文案会进公开事件流），不含上游细节", async () => {
    const { BudgetExceededError } = await budgetModule();
    const msg = new BudgetExceededError(1234, 1000).message;
    expect(msg).toContain("1234/1000");
    expect(msg).not.toMatch(/https?:|apiKey|Bearer|provider|model=/i);
  });

  it("warn 日志带 purpose/used/budget，供 S6.1 之前的运营排查", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "100");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resetBudgetCache } = await budgetModule();
    resetBudgetCache();
    h.aggregate.mockResolvedValue(sumOf(150));
    const { assertWithinBudget } = await budgetModule();
    await expect(assertWithinBudget("dm")).rejects.toThrow(/预算已用尽/);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining("budget_exceeded purpose=dm used=150 budget=100"));
    warn.mockRestore();
  });
});
