import { describe, it, expect, vi } from "vitest";
import { isSafetyRefusal } from "./output-tokens";

const REFUSAL = "很抱歉，关于这个问题我无法提供相应的信息。如果您有其他问题，我将很愿意为您回答。";
const mock = vi.hoisted(() => ({
  logs: [] as Array<Record<string, unknown>>,
  streamRequests: [] as Array<Array<{ role: string; content: string }>>,
  callRequests: [] as Array<Array<{ role: string; content: string }>>,
  calls: { mode: "anchored_ok" as "anchored_ok" | "always_refuse" | "never_refuse" },
}));
const isRefused = (messages: Array<{ role: string; content: string }>) =>
  mock.calls.mode === "always_refuse" || (mock.calls.mode === "anchored_ok" && !messages.some((m) => m.content.includes("本局是虚构的中文推理游戏")));

vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "test" }));
vi.mock("@/lib/db", () => ({
  db: {
    modelBinding: {
      findUnique: async () => ({
        id: "b", providerId: "p", modelId: "m", supportsSystem: true, supportsJson: false, detectedSystemSupport: true,
        provider: { id: "p", enabled: true, name: "mock", baseUrl: "https://mock.test/v1", protocol: "openai_compatible", apiKeyCipher: "test" },
      }),
      updateMany: async () => undefined,
    },
    usageLog: { create: async ({ data }: { data: Record<string, unknown> }) => { mock.logs.push(data); } },
  },
}));
vi.mock("ai", () => ({
  generateText: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    mock.callRequests.push(messages);
    if (isRefused(messages)) throw new Error(REFUSAL);
    return { text: "合法回答", usage: { promptTokens: 10, completionTokens: 2 } };
  },
  streamText: ({ messages, onError }: { messages: Array<{ role: string; content: string }>; onError: (e: { error: unknown }) => void }) => {
    mock.streamRequests.push(messages);
    return {
      textStream: (async function* () {
        if (isRefused(messages)) { onError({ error: new Error(REFUSAL) }); return; }
        yield "合法回答";
      })(),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 2 }),
    };
  },
}));

const anchored = (messages: Array<{ role: string; content: string }>) => messages.some((m) => m.content.includes("本局是虚构的中文推理游戏"));
const opts = { purpose: "player" as const, messages: [{ role: "user" as const, content: "请以赵凯的身份回答质询" }] };

describe("内容审核拒答的角色锚定重试", () => {
  it("流式：首次被拒后补角色锚定重试成功，只记一条成功日志", async () => {
    mock.logs.length = 0; mock.streamRequests.length = 0; mock.calls.mode = "anchored_ok";
    const { chatStream } = await import("./client");
    let text = "";
    for await (const chunk of chatStream(opts)) text += chunk;
    expect(text).toBe("合法回答");
    expect(mock.streamRequests).toHaveLength(2);
    expect(anchored(mock.streamRequests[0])).toBe(false);
    expect(anchored(mock.streamRequests[1])).toBe(true);
    expect(mock.logs).toHaveLength(1);
    expect(mock.logs[0]).toMatchObject({ ok: true, retryCount: 1, fallbackReason: "safety_refusal_reanchored" });
  });

  it("流式：锚定后仍被拒只重试这一次，失败日志记 retryCount=1 并抛出", async () => {
    mock.logs.length = 0; mock.streamRequests.length = 0; mock.calls.mode = "always_refuse";
    const { chatStream } = await import("./client");
    let thrown = "";
    try {
      for await (const chunk of chatStream(opts)) void chunk;
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(mock.streamRequests).toHaveLength(2);
    expect(anchored(mock.streamRequests[1])).toBe(true);
    expect(thrown).toContain("LLM 流式调用失败");
    expect(mock.logs).toHaveLength(1);
    expect(mock.logs[0]).toMatchObject({ ok: false, error: REFUSAL, retryCount: 1 });
  });

  it("非流式：chat() 在锚定后重试一次并计入 retryCount", async () => {
    mock.logs.length = 0; mock.callRequests.length = 0; mock.calls.mode = "anchored_ok";
    const { chat } = await import("./client");
    const r = await chat(opts);
    expect(r.text).toBe("合法回答");
    expect(mock.callRequests).toHaveLength(2);
    expect(anchored(mock.callRequests[0])).toBe(false);
    expect(anchored(mock.callRequests[1])).toBe(true);
    expect(mock.logs).toHaveLength(1);
    expect(mock.logs[0]).toMatchObject({ ok: true, retryCount: 1, fallbackReason: "safety_refusal_reanchored" });
  });

  it("非流式：没有触发拒答时不额外发请求", async () => {
    mock.logs.length = 0; mock.callRequests.length = 0; mock.calls.mode = "never_refuse";
    const { chat } = await import("./client");
    await expect(chat(opts)).resolves.toMatchObject({ text: "合法回答" });
    expect(mock.callRequests).toHaveLength(1);
    expect(anchored(mock.callRequests[0])).toBe(false);
    expect(mock.logs[0]).toMatchObject({ ok: true, retryCount: 0 });
  });

  it("非流式：锚定后仍被拒则抛出脱敏报文，原始审核文本只进日志", async () => {
    mock.logs.length = 0; mock.callRequests.length = 0; mock.calls.mode = "always_refuse";
    const { chat } = await import("./client");
    const err = await chat(opts).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("LLM 调用失败");
    expect(err?.message).not.toContain(REFUSAL);
    expect(mock.callRequests).toHaveLength(2);
    expect(mock.logs[mock.logs.length - 1]).toMatchObject({ ok: false, error: REFUSAL, retryCount: 1, fallbackReason: "safety_refusal_reanchored" });
  });

  it("非流式：带 segments 时锚定追加进硬区尾部，随消息一起发出", async () => {
    mock.logs.length = 0; mock.callRequests.length = 0; mock.calls.mode = "anchored_ok";
    const { chat } = await import("./client");
    await chat({
      ...opts,
      segments: { system: "规则", log: "现场记录", anchoredHead: "角色卡", droppable: [], anchoredTail: "输出要求" },
    });
    expect(mock.callRequests).toHaveLength(2);
    expect(anchored(mock.callRequests[1])).toBe(true);
    expect(mock.callRequests[1].some((m) => m.content.includes("输出要求"))).toBe(true);
    expect(mock.logs[0]).toMatchObject({ ok: true, retryCount: 1, fallbackReason: "safety_refusal_reanchored" });
  });
});

describe("isSafetyRefusal 判类", () => {
  it("识别中英助手口吻拒绝", () => {
    for (const msg of [REFUSAL, "抱歉，我无法回答这个问题。", "As an AI language model, I can't help with that.", new Error("I'm sorry, but I can't provide that information")]) {
      expect(isSafetyRefusal(msg)).toBe(true);
    }
  });
  it("不把传输故障和空正文当拒答", () => {
    for (const msg of [new Error("fetch failed"), new Error("HTTP 429 rate limit"), new Error("模型返回空正文"), new Error("上下文超出模型窗口：估算输入 9 tokens")]) {
      expect(isSafetyRefusal(msg)).toBe(false);
    }
  });
});
