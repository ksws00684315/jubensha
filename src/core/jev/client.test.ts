import { afterEach, describe, expect, it, vi } from "vitest";
import { askSystemOne, JevError, MAX_CHOICE_OPTIONS, type JevEndpoint } from "./client";

const endpoint: JevEndpoint = { baseUrl: "https://api.typesafe.ai", apiKey: "test-key" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** 记录每次请求，返回可控响应序列（耗尽后重复末个） */
function stubFetch(...responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = responses[Math.min(i++, responses.length - 1)];
    return next();
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const voteChoice = { type: "choice" as const, instructions: "谁是凶手", criteria: { "1": "沈月", "2": "陆鸣", "3": "周砚" } };
const noDelay = { retryDelaysMs: [] as number[] };

describe("请求装配", () => {
  it("按 /v1/systemone 协议装配：state+questions，不走 OpenAI 兼容字段", async () => {
    const calls = stubFetch(() => json({ answers: { vote: { type: "choice", choice: "2", probabilities: { "2": 0.61 }, confidence: 0.6 } }, usage: { input_tokens: 120, output_tokens: 0 } }));
    const res = await askSystemOne(endpoint, { state: { 座位: 1 }, questions: { vote: voteChoice } }, noDelay);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key");
    expect(calls[0].body).toEqual({ state: { 座位: 1 }, model: "jev-latest", questions: { vote: { type: "choice", instructions: "谁是凶手", criteria: voteChoice.criteria } } });
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 0 });
  });

  it("baseUrl 已含完整端点或尾斜杠都不产生双段路径", async () => {
    for (const baseUrl of ["https://api.typesafe.ai/", "https://api.typesafe.ai/v1/systemone", "https://gw.internal/proxy/typesafe"]) {
      const calls = stubFetch(() => json({ answers: {} }));
      await askSystemOne({ baseUrl, apiKey: "k" }, { state: "s", questions: { q: { type: "noul", instructions: "够不够定人" } } }, noDelay);
      expect(calls[0].url).toBe(baseUrl.replace(/\/+$/, "").replace(/\/v1\/systemone$/i, "") + "/v1/systemone");
    }
  });

  it("一次请求批量带多个 questions", async () => {
    const calls = stubFetch(() => json({ answers: { a: { choice: "1" }, b: { noul: 0.2 } } }));
    const res = await askSystemOne(endpoint, { state: "s", questions: { a: voteChoice, b: { type: "noul", instructions: "要不要发言" } } }, noDelay);
    expect(calls).toHaveLength(1);
    expect(Object.keys(res.answers)).toEqual(["a", "b"]);
    expect(res.answers.b).toMatchObject({ type: "noul", probability: 0.2 });
  });
});

describe("响应解析与业务层失败标记", () => {
  it("choice 命中候选集时给出键与该键概率", async () => {
    stubFetch(() => json({ answers: { vote: { choice: "2", probabilities: { "1": 0.2, "2": 0.61 }, confidence: 0.6 } } }));
    const res = await askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, noDelay);
    expect(res.answers.vote).toMatchObject({ type: "choice", key: "2", probability: 0.61, confidence: 0.6, rejected: false });
  });

  it("choice 落在候选集外视为 rejected，供调用方回落现网路径", async () => {
    stubFetch(() => json({ answers: { vote: { choice: "9", probabilities: { "9": 0.9 } } } }));
    const res = await askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, noDelay);
    expect(res.answers.vote).toMatchObject({ type: "choice", key: null, rejected: true });
  });

  it("answers 缺该项时不抛错，按 rejected 处理", async () => {
    stubFetch(() => json({ answers: {} }));
    const res = await askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, noDelay);
    expect(res.answers.vote).toMatchObject({ key: null, rejected: true, probability: null, confidence: null });
  });

  it("score 返回分值与档位说明", async () => {
    stubFetch(() => json({ answers: { s: { type: "score", score: 3, legend: { "3": "疑点较大" } } } }));
    const res = await askSystemOne(endpoint, { state: "s", questions: { s: { type: "score", instructions: "可疑程度", criteria: { "1": "很低", "3": "很高" } } } }, noDelay);
    expect(res.answers.s).toMatchObject({ type: "score", score: 3, legend: { "3": "疑点较大" } });
  });
});

describe("失败与退避", () => {
  it("429 按退避重试直至成功", async () => {
    const calls = stubFetch(() => new Response("rate limited", { status: 429 }), () => new Response("boom", { status: 503 }), () => json({ answers: { vote: { choice: "1" } } }));
    const res = await askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, { retryDelaysMs: [1, 1] });
    expect(calls).toHaveLength(3);
    expect(res.answers.vote).toMatchObject({ key: "1" });
  });

  it("400 是请求本身不被接受，退避后再打也是浪费：不重试", async () => {
    const calls = stubFetch(() => new Response("bad questions", { status: 400 }));
    await expect(askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, { retryDelaysMs: [1, 1] })).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it("退避次数用尽后抛出最后一次错误", async () => {
    const calls = stubFetch(() => new Response("down", { status: 503 }));
    await expect(askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, { retryDelaysMs: [1] })).rejects.toBeInstanceOf(JevError);
    expect(calls).toHaveLength(2);
  });

  it("网络异常同样重试，恢复后成功", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      if (n === 1) throw new Error("socket hang up");
      return json({ answers: { vote: { choice: "3" } } });
    });
    const res = await askSystemOne(endpoint, { state: "s", questions: { vote: voteChoice } }, { retryDelaysMs: [1] });
    expect(n).toBe(2);
    expect(res.answers.vote).toMatchObject({ key: "3" });
  });
});

describe("边界校验（不发请求即失败）", () => {
  it("缺 key 直接抛错，避免打一次必败请求", async () => {
    const calls = stubFetch(() => json({ answers: {} }));
    await expect(askSystemOne({ baseUrl: "https://api.typesafe.ai", apiKey: "  " }, { state: "s", questions: { vote: voteChoice } })).rejects.toThrow(/API key/);
    expect(calls).toHaveLength(0);
  });

  it("choice 候选集为空或超上限时抛错", async () => {
    await expect(askSystemOne(endpoint, { state: "s", questions: { v: { type: "choice", instructions: "x", criteria: {} } } }, noDelay)).rejects.toThrow(/criteria 为空/);
    const criteria = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [String(i), `角色${i}`]));
    await expect(askSystemOne(endpoint, { state: "s", questions: { v: { type: "choice", instructions: "x", criteria } } }, noDelay)).rejects.toThrow(new RegExp(`上限 ${MAX_CHOICE_OPTIONS}`));
  });

  it("questions 为空抛错", async () => {
    await expect(askSystemOne(endpoint, { state: "s", questions: {} }, noDelay)).rejects.toThrow(/至少带一个 question/);
  });
});
