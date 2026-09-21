import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isRefusalBoilerplate } from "@/core/llm/output-tokens";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { initialState } from "@/core/engine/state";
import type { EngineEvent } from "@/core/engine/types";

const REFUSAL = "很抱歉，关于这个问题我无法提供相应的信息。如果您有其他问题，我将很愿意为您回答。";
const REAL_LINE = "那晚我一到包厢就坐下了，药盒是我先看见的。";

const mock = vi.hoisted(() => ({
  streamMode: "refuse" as "refuse" | "ok",
  chatTexts: [] as string[],
  chatRequests: [] as Array<Array<{ role: string; content: string }>>,
  streamRequests: 0,
}));

vi.mock("@/core/llm/client", () => ({
  ROLE_ANCHOR: "【输出方式】上一轮你以助手身份拒绝了。",
  extractJson: (s: string) => s,
  chat: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    mock.chatRequests.push(messages);
    const text = mock.chatTexts.shift() ?? REAL_LINE;
    return { text, promptTokens: 10, completionTokens: 10, providerName: "mock", modelId: "m" };
  },
  chatStream: () => {
    mock.streamRequests += 1;
    const it = (async function* () {
      if (mock.streamMode === "refuse") {
        yield REFUSAL;
        throw new Error(REFUSAL);
      }
      yield REAL_LINE;
    })();
    return {
      [Symbol.asyncIterator]: () => it,
      [Symbol.iterator]: () => {
        throw new Error("流式发言不得被同步消费");
      },
    };
  },
}));

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));
function ctxFor() {
  const order = doc.characters.map((c) => c.id);
  const state = initialState(order.map((characterId, index) => ({ index, kind: "ai" as const, characterId, playerName: `AI${index}` })));
  state.phase = "DISCUSSION";
  state.round = 1;
  const events: EngineEvent[] = [];
  return { script: doc, state, events, gameId: "g-refusal" };
}

describe("玩家台词层的审核拒答处理", () => {
  beforeEach(() => {
    mock.streamMode = "refuse";
    mock.chatTexts.length = 0;
    mock.chatRequests.length = 0;
    mock.streamRequests = 0;
  });

  it("流式：拒绝语既不放出也不抛错，交给调用方的非流式兜底", async () => {
    const { agent } = await import("./index");
    let out = "";
    const chunks: string[] = [];
    for await (const d of agent.streamPlayerSpeech(ctxFor(), 1, { intro: true, recall: "" })) chunks.push(d);
    out = chunks.join("");
    expect(out).toBe("");
    expect(mock.streamRequests).toBe(1);
  });

  it("流式：正常台词逐句放出，不被判定为拒绝语", async () => {
    mock.streamMode = "ok";
    const { agent } = await import("./index");
    const chunks: string[] = [];
    for await (const d of agent.streamPlayerSpeech(ctxFor(), 1, { intro: true, recall: "" })) chunks.push(d);
    expect(chunks.join("")).toContain("药盒");
  });

  it("非流式：拒绝语被当正文返回时，补角色锚定重发一次并采用第二次结果", async () => {
    mock.chatTexts.push(REFUSAL, REAL_LINE);
    const { agent } = await import("./index");
    const text = await agent.playerSpeak(ctxFor(), 1, { intro: true, recall: "" });
    expect(text).toContain("药盒");
    expect(mock.chatRequests).toHaveLength(2);
    expect(mock.chatRequests[0].some((m) => m.content.includes("【输出方式】"))).toBe(false);
    expect(mock.chatRequests[1].some((m) => m.content.includes("【输出方式】"))).toBe(true);
  });

  it("非流式：锚定后仍是被拒话术时返回空，不把拒绝语上台", async () => {
    mock.chatTexts.push(REFUSAL, REFUSAL);
    const { agent } = await import("./index");
    await expect(agent.playerSpeak(ctxFor(), 1, { intro: true, recall: "" })).resolves.toBe("");
    expect(mock.chatRequests).toHaveLength(2);
  });
});

describe("isRefusalBoilerplate", () => {
  it("认出 provider 的客服式拒绝话术", () => {
    expect(isRefusalBoilerplate(REFUSAL)).toBe(true);
    expect(isRefusalBoilerplate("很抱歉，我无法回答这个问题，如果您有其他问题我很乐意为您解答。")).toBe(true);
    expect(isRefusalBoilerplate("As an AI language model, I can't provide that information.")).toBe(true);
  });
  it("角色台词里的正常拒绝不误判", () => {
    for (const line of [
      "抱歉，我不能提供他的住处，那是他自己的事。",
      "这件事我无法回答，你们去问当天在场的人。",
      "如果您有其他问题，可以明天到我办公室来谈。",
      REAL_LINE,
    ]) expect(isRefusalBoilerplate(line)).toBe(false);
  });
});
