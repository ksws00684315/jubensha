import { describe, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({ detected: null as boolean | null, logs: [] as Array<Record<string, unknown>>, requests: [] as Array<Array<{ role: string; content: string }>> }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "test" }));
vi.mock("@/lib/db", () => ({ db: {
  modelBinding: { findUnique: async () => ({ id: "b", providerId: "p", modelId: "m", supportsSystem: true, supportsJson: false, detectedSystemSupport: mock.detected, provider: { id: "p", enabled: true, name: "mock", baseUrl: "https://mock.test/v1", protocol: "openai_compatible", apiKeyCipher: "test" } }), updateMany: async () => { mock.detected = false; } },
  usageLog: { create: async ({ data }: { data: Record<string, unknown> }) => { mock.logs.push(data); } },
} }));
vi.mock("ai", () => ({ generateText: vi.fn(), streamText: ({ messages, onError }: { messages: Array<{ role: string; content: string }>; onError: (e: { error: unknown }) => void }) => {
  mock.requests.push(messages);
  return { textStream: (async function* () {
    if (messages.some((m) => m.role === "system")) { onError({ error: new Error("System messages are not allowed. Use the instructions option instead") }); return; }
    yield "合法回答";
  })(), usage: Promise.resolve({ inputTokens: 10, outputTokens: 2 }) };
} }));
describe("system 协议持久化与逻辑调用记账", () => {
  it("兼容重试只记一条成功日志，模块重载复用检测", async () => {
    mock.detected = null; mock.logs.length = 0; mock.requests.length = 0;
    vi.resetModules();
    const opts = { purpose: "player" as const, messages: [{ role: "system" as const, content: "规则" }, { role: "user" as const, content: "任务" }] };
    const { chatStream } = await import("./client");
    let text = ""; for await (const chunk of chatStream(opts)) text += chunk;
    expect(text).toBe("合法回答"); expect(mock.logs).toHaveLength(1);
    expect(mock.logs[0]).toMatchObject({ ok: true, retryCount: 1, fallbackReason: "system_role_rejected" });
    expect(mock.detected).toBe(false);
    vi.resetModules();
    const restarted = await import("./client");
    for await (const chunk of restarted.chatStream(opts)) void chunk;
    expect(mock.requests).toHaveLength(3);
    expect(mock.requests[2].every((m) => m.role !== "system")).toBe(true);
    expect(mock.logs[1]).toMatchObject({ ok: true, retryCount: 0 });
  });
});
