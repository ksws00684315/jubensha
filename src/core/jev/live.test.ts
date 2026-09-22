import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { initialState } from "@/core/engine/state";
import type { EngineEvent, GameState } from "@/core/engine/types";
import { jevLocationFallback, jevVoteFallback, liveCallsUsed, shadowLocation, shadowPublish, shadowVote, type JevLiveMode } from "./live";

const rec = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  requests: [] as Array<{ state: unknown; questions: Record<string, unknown> }>,
  replies: [] as Array<(req: { questions: Record<string, unknown> }) => unknown>,
  calls: 0,
}));

vi.mock("@/lib/db", () => ({
  db: { jevShadowLog: { create: async ({ data }: { data: Record<string, unknown> }) => void rec.rows.push(data) } },
}));

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    askSystemOne: async (_ep: unknown, req: { state: unknown; questions: Record<string, unknown> }) => {
      rec.calls += 1;
      rec.requests.push(req);
      const next = rec.replies.shift();
      if (!next) throw new Error("测试未预置响应");
      return next(req);
    },
  };
});

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

let gameSeq = 0;

function makeCtx(phase: GameState["phase"], round: number): { script: typeof doc; state: GameState; events: EngineEvent[]; gameId: string } {
  const state = initialState(doc.characters.map((character, index) => ({ index, kind: "ai" as const, characterId: character.id, playerName: `AI${index}` })));
  state.phase = phase;
  state.round = round;
  state.clueStates["teacup"] = { discoveredBy: 1, isPublic: true };
  const events: EngineEvent[] = [
    {
      seq: "1",
      createdAt: "2026-09-22T00:00:00.000Z",
      type: "clue",
      phase: "SEARCH",
      round: 1,
      fromSeat: 1,
      toSeat: null,
      visibility: "public",
      content: { clueId: "teacup", clueName: "参茶残液", clueContent: "杯底有沉淀。" },
    },
  ];
  return { script: doc, state, events, gameId: `g-${phase}-${round}-${(gameSeq += 1)}` };
}

/** 两个开关默认同时打开，好让同一局里影子与接管各自都能被验到 */
function enableEnv(modes: JevLiveMode[] = ["shadow", "fallback"], slots = "vote,location,publish", caps: Partial<Record<JevLiveMode, number>> = {}) {
  process.env.JEV_API_KEY = "test-key";
  process.env.JEV_SHADOW = modes.includes("shadow") ? "1" : "0";
  process.env.JEV_FALLBACK = modes.includes("fallback") ? "1" : "0";
  process.env.JEV_LIVE_SLOTS = slots;
  if (caps.shadow) process.env.JEV_SHADOW_MAX_CALLS = String(caps.shadow);
  if (caps.fallback) process.env.JEV_FALLBACK_MAX_CALLS = String(caps.fallback);
}

afterEach(() => {
  delete process.env.JEV_SHADOW;
  delete process.env.JEV_FALLBACK;
  delete process.env.JEV_API_KEY;
  delete process.env.JEV_LIVE_SLOTS;
  delete process.env.JEV_SHADOW_MAX_CALLS;
  delete process.env.JEV_FALLBACK_MAX_CALLS;
  rec.calls = 0;
  rec.rows = [];
  rec.requests = [];
  rec.replies = [];
});

/** 响应按请求里的题号回填，测试不必关心 vote/answer 各自的 id */
const choice = (key: string | null, probability = 0.6) => (req: { questions: Record<string, unknown> }) => ({
  answers: { [Object.keys(req.questions)[0]]: { type: "choice", key, probability: key === null ? null : probability, confidence: 0.5, rejected: key === null } },
  usage: { inputTokens: 1000, outputTokens: 0 },
  latencyMs: 320,
});
const noul = (probability: number) => (req: { questions: Record<string, unknown> }) => ({
  answers: { [Object.keys(req.questions)[0]]: { type: "noul", probability, confidence: 0.7 } },
  usage: { inputTokens: 800, outputTokens: 0 },
  latencyMs: 210,
});
const boom = (message: string) => () => {
  throw new Error(message);
};

describe("两个开关各自独立", () => {
  it("未配 JEV_SHADOW/JEV_FALLBACK/API_KEY 时整体静默：不请求、不写库、不占预算", async () => {
    const ctx = makeCtx("VOTE", 2);
    await expect(shadowVote(ctx, 0, 1)).resolves.toBeUndefined();
    expect(await jevVoteFallback(ctx, 0)).toBeNull();
    expect(rec.calls).toBe(0);
    expect(rec.rows).toHaveLength(0);
    expect(liveCallsUsed(ctx.gameId, "shadow")).toBe(0);
    expect(liveCallsUsed(ctx.gameId, "fallback")).toBe(0);
  });

  it("只开影子：接管入口静默，影子照常一问一记", async () => {
    enableEnv(["shadow"]);
    rec.replies = [choice("1")];
    const ctx = makeCtx("VOTE", 2);
    await shadowVote(ctx, 0, 1);
    expect(await jevVoteFallback(ctx, 1)).toBeNull();
    expect(rec.calls).toBe(1);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({ usedForAction: false });
  });

  it("只开接管：影子入口静默（不烧那 $2/局），兜底那一问照记", async () => {
    enableEnv(["fallback"]);
    rec.replies = [choice("2", 0.61)];
    const ctx = makeCtx("VOTE", 2);
    await shadowVote(ctx, 0, 1);
    await shadowLocation(ctx, 0, ["书房", "温室"], "书房");
    await shadowPublish(ctx, 0, "teacup", true);
    expect(await jevVoteFallback(ctx, 1)).toEqual({ target: 2, probability: 0.61 });
    expect(rec.calls).toBe(1);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({ slot: "vote", jevKey: "2", actualKey: null, usedForAction: true });
  });

  it("两份额度互不饿死：影子挂满后接管仍能问", async () => {
    enableEnv(["shadow", "fallback"], "vote", { shadow: 1 });
    rec.replies = [choice("1"), choice("2"), choice("3")];
    const ctx = makeCtx("VOTE", 2);
    await shadowVote(ctx, 0, 1);
    await shadowVote(ctx, 1, 2);
    expect(liveCallsUsed(ctx.gameId, "shadow")).toBe(1);
    expect(await jevVoteFallback(ctx, 3)).not.toBeNull();
    expect(liveCallsUsed(ctx.gameId, "fallback")).toBe(1);
    expect(rec.calls).toBe(2);
  });

  it("槽位开关对两种模式共用：只开 vote 时选址与公开都不问", async () => {
    enableEnv(["shadow", "fallback"], "vote");
    const ctx = makeCtx("SEARCH", 1);
    await shadowLocation(ctx, 0, ["书房", "温室"], "书房");
    expect(await jevLocationFallback(ctx, 0, ["书房", "温室"])).toBeNull();
    expect(rec.calls).toBe(0);
    expect(rec.rows).toHaveLength(0);
  });

  it("每局额度用满后即停，不再产生请求与记账", async () => {
    enableEnv(["shadow"], "vote", { shadow: 2 });
    rec.replies = [choice("1"), choice("2")];
    const ctx = makeCtx("VOTE", 2);
    await shadowVote(ctx, 0, 1);
    await shadowVote(ctx, 1, 2);
    await shadowVote(ctx, 2, 1);
    expect(rec.calls).toBe(2);
    expect(rec.rows).toHaveLength(2);
    expect(liveCallsUsed(ctx.gameId, "shadow")).toBe(2);
  });
});

describe("投票影子", () => {
  it("记下同意/非法/接管三个维度，且只问 vote 一题", async () => {
    enableEnv();
    rec.replies = [choice("2", 0.8)];
    const ctx = makeCtx("VOTE", 2);
    await shadowVote(ctx, 0, 2);
    expect(Object.keys(rec.requests[0].questions)).toEqual(["vote"]);
    expect(rec.rows[0]).toMatchObject({
      gameId: ctx.gameId,
      slot: "vote",
      seatIndex: 0,
      phase: "VOTE",
      round: 2,
      jevKey: "2",
      jevProbability: 0.8,
      actualKey: "2",
      agreed: true,
      legal: true,
      usedForAction: false,
      inputTokens: 1000,
      latencyMs: 320,
      ok: true,
    });
    expect(Number(rec.rows[0].stateChars)).toBeGreaterThan(100);
  });

  it("与现网票不同时 agreed=false，仍然合法可对照", async () => {
    enableEnv();
    rec.replies = [choice("3")];
    const ctx = makeCtx("VOTE", 2);
    await shadowVote(ctx, 0, 1);
    expect(rec.rows[0]).toMatchObject({ jevKey: "3", actualKey: "1", agreed: false, legal: true });
  });

  it("选了自己的座位即判非法，接管不采用", async () => {
    enableEnv();
    rec.replies = [choice("0")];
    const ctx = makeCtx("VOTE", 2);
    expect(await jevVoteFallback(ctx, 0)).toBeNull();
    expect(rec.rows[0]).toMatchObject({ jevKey: "0", legal: false, usedForAction: true, agreed: null });
  });

  it("接管成功时返回座位索引并标 usedForAction，actual 留空", async () => {
    enableEnv();
    rec.replies = [choice("4", 0.55)];
    const ctx = makeCtx("VOTE", 2);
    expect(await jevVoteFallback(ctx, 0)).toEqual({ target: 4, probability: 0.55 });
    expect(rec.rows[0]).toMatchObject({ jevKey: "4", actualKey: null, agreed: null, legal: true, usedForAction: true });
  });

  it("调用失败写一条 ok=false，不抛给引擎", async () => {
    enableEnv();
    rec.replies = [boom("max_tokens_exceeded")];
    const ctx = makeCtx("VOTE", 2);
    await expect(shadowVote(ctx, 0, 1)).resolves.toBeUndefined();
    expect(await jevVoteFallback(ctx, 1)).toBeNull();
    expect(rec.rows[0]).toMatchObject({ ok: false, legal: false, error: "max_tokens_exceeded", inputTokens: 0 });
  });
});

describe("选址与公开影子", () => {
  it("选址按候选序号出题，接管回落到地点名", async () => {
    enableEnv();
    rec.replies = [choice("1"), choice("0")];
    const ctx = makeCtx("SEARCH", 2);
    await shadowLocation(ctx, 0, ["书房", "温室", "门厅"], "温室");
    expect(rec.rows[0]).toMatchObject({ slot: "location", jevKey: "1", actualKey: "1", agreed: true, legal: true, usedForAction: false });
    expect(await jevLocationFallback(ctx, 1, ["书房", "温室", "门厅"])).toBe("书房");
    expect(rec.rows[1]).toMatchObject({ slot: "location", jevKey: "0", actualKey: null, usedForAction: true });
  });

  it("选址越界或没有候选地点都不接管", async () => {
    enableEnv();
    rec.replies = [choice("7"), choice("0")];
    const ctx = makeCtx("SEARCH", 2);
    expect(await jevLocationFallback(ctx, 0, ["书房", "温室"])).toBeNull();
    expect(rec.rows[0]).toMatchObject({ legal: false, jevKey: "7" });
    expect(await jevLocationFallback(ctx, 1, [])).toBeNull();
    expect(rec.calls).toBe(1);
  });

  it("公开/私藏用 noul，概率过半点记为 true", async () => {
    enableEnv();
    rec.replies = [noul(0.72), noul(0.2)];
    const ctx = makeCtx("SEARCH", 2);
    await shadowPublish(ctx, 0, "teacup", false);
    await shadowPublish(ctx, 1, "teacup", false);
    expect(rec.rows[0]).toMatchObject({ slot: "publish", jevKey: "true", jevProbability: 0.72, actualKey: "false", agreed: false, legal: true, usedForAction: false });
    expect(rec.rows[1]).toMatchObject({ jevKey: "false", agreed: true });
  });

  it("未知线索卡不提问", async () => {
    enableEnv();
    const ctx = makeCtx("SEARCH", 2);
    await shadowPublish(ctx, 0, "not-a-clue", true);
    expect(rec.calls).toBe(0);
  });
});
