import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { initialState } from "@/core/engine/state";
import { bigramSimilarity } from "@/core/engine/questions";
import type { EngineEvent, PlayerActionPlan } from "@/core/engine/types";
import { degradedSpeechLine, makeNoveltyJudge } from "./review";

const mock = vi.hoisted(() => ({
  replies: [] as string[],
  failure: false,
  calls: 0,
}));

vi.mock("@/core/llm/client", () => ({
  ROLE_ANCHOR: "【输出方式】",
  extractJson: (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  },
  chat: async () => {
    mock.calls += 1;
    if (mock.failure) throw new Error("审查调用不可用");
    return { text: mock.replies.shift() ?? '{"ok":true}', promptTokens: 10, completionTokens: 10, providerName: "mock", modelId: "m" };
  },
  chatStream: () => {
    throw new Error("本用例不走流式");
  },
}));

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

/** 参茶残液是公开材料：本轮由主持补发公开，作为「场上新料」的判据来源 */
const PRIOR = "参茶的味道不对，沈万山当晚只喝过这一杯，我要问清楚是谁泡的。";
const ECHO = "参茶的味道不对，沈万山当晚只喝过这一杯，我想问清楚是谁泡的茶。";

function ctxFor(plan?: Partial<PlayerActionPlan>) {
  const order = doc.characters.map((c) => c.id);
  const state = initialState(order.map((characterId, index) => ({ index, kind: "ai" as const, characterId, playerName: `AI${index}` })));
  state.phase = "DISCUSSION";
  state.round = 1;
  state.clueStates["teacup"] = { discoveredBy: 1, isPublic: true };
  const events: EngineEvent[] = [
    ev({ type: "clue", seq: "1", fromSeat: 1, content: { clueId: "teacup", clueName: "参茶残液" } }),
    ev({ type: "speech", seq: "2", fromSeat: 1, content: { text: PRIOR } }),
  ];
  if (plan) state.actionPlans = { "0": { objectiveId: null, targetSeat: null, discloseClueIds: [], holdClueIds: [], nextAction: "ask", ...plan } };
  return { script: doc, state, events, gameId: "g-refine" };
}

function ev(partial: Partial<EngineEvent> & { type: EngineEvent["type"]; seq: string }): EngineEvent {
  return {
    phase: "DISCUSSION",
    round: 1,
    fromSeat: null,
    toSeat: null,
    visibility: "public",
    content: {},
    createdAt: "2026-09-22T00:00:00.000Z",
    ...partial,
  } as EngineEvent;
}

describe("台词二次审查：本地启发式不得单独否决审查员", () => {
  beforeEach(() => {
    mock.replies.length = 0;
    mock.failure = false;
    mock.calls = 0;
  });

  it("审查员判 ok 时保留原台词，哪怕本地 bigram 认定重复", async () => {
    mock.replies.push('{"ok":true}');
    const { agent } = await import("./index");
    const text = await agent.refineSpeech(ctxFor({ nextAction: "ask", targetSeat: 1 }), 0, ECHO);
    expect(text).toBe(ECHO);
    expect(mock.calls).toBe(1);
  });

  it("本轮有新公开线索时，仍按审查员的改写替换", async () => {
    mock.replies.push('{"ok":false,"text":"那杯茶的苦味我尝出来了，泡茶的人手上有把钥匙。"}');
    const { agent } = await import("./index");
    const text = await agent.refineSpeech(ctxFor({ nextAction: "probe" }), 0, ECHO);
    expect(text).toContain("苦味");
  });

  it("审查调用失败且确实判为复读时，降级为符合本轮意图的短话（不再是全场同一句）", async () => {
    mock.failure = true;
    const { agent } = await import("./index");
    const ask = await agent.refineSpeech(ctxFor({ nextAction: "ask", targetSeat: 1 }), 0, ECHO);
    const wait = await agent.refineSpeech(ctxFor({ nextAction: "wait" }), 0, ECHO);
    expect(ask).not.toBe(ECHO);
    expect(ask).not.toContain("我同意已有的判断");
    expect(wait).not.toBe(ask);
  });

  it("没有任何新料判据时不判复读：保留原文，也不发起审查调用", async () => {
    const ctx = ctxFor({ nextAction: "ask" });
    ctx.events = ctx.events.filter((e) => e.type !== "clue");
    const { agent } = await import("./index");
    const text = await agent.refineSpeech(ctx, 0, ECHO);
    expect(text).toBe(ECHO);
    expect(mock.calls).toBe(0);
  });

  it("台词点名本轮新公开的线索时不算复读", async () => {
    const candidate = "参茶残液就在这里：沈万山当晚只喝过这一杯，我要问清楚是谁泡的。";
    const { agent } = await import("./index");
    expect(bigramSimilarity(candidate, PRIOR)).toBeGreaterThanOrEqual(0.72);
    expect(await agent.refineSpeech(ctxFor({ nextAction: "ask" }), 0, candidate)).toBe(candidate);
    expect(mock.calls).toBe(0);
  });
});

describe("makeNoveltyJudge", () => {
  const fresh = ev({ type: "clue", seq: "1", content: { clueId: "teacup" } });
  const speech = (text: string, refs?: string[]) => ev({ type: "speech", seq: "2", fromSeat: 1, content: { text, focusEvidenceIds: refs } });

  it("本轮无新公开线索且计划未声明证据 → 不可判，禁止降级", () => {
    const judge = makeNoveltyJudge(doc, [speech(PRIOR)], "DISCUSSION", 1, []);
    expect(judge.judgeable).toBe(false);
  });

  it("点名引用本轮新公开的线索即算新料；上一段已点过则不算", () => {
    const named = speech("参茶残液已经摆到台面上了，这一点不用再说。");
    const judge = makeNoveltyJudge(doc, [fresh, named], "DISCUSSION", 1, []);
    expect(judge.novelVs("参茶残液说明他当晚喝过两杯", named)).toBe(false);
    expect(judge.novelVs("账本被锁进了箱子", speech("账本被锁进了箱子，这个我知道。"))).toBe(false);
    const clean = makeNoveltyJudge(doc, [fresh, speech("那晚我一直在门廊。")], "DISCUSSION", 1, []);
    expect(clean.novelVs("参茶残液说明他当晚喝过两杯", speech("那晚我一直在门廊。"))).toBe(true);
  });
});

describe("degradedSpeechLine", () => {
  it("按本轮意图分流，避免多座位同时命中时字字相同", () => {
    const plan = (nextAction: PlayerActionPlan["nextAction"]): PlayerActionPlan => ({ objectiveId: null, targetSeat: null, discloseClueIds: [], holdClueIds: [], nextAction });
    const lines = new Set(["ask", "defend", "probe", "exchange", "wait"].map((a) => degradedSpeechLine(plan(a as PlayerActionPlan["nextAction"]), null)));
    expect(lines.size).toBe(5);
    expect(degradedSpeechLine(plan("ask"), "周伯")).toContain("周伯");
  });
});
