import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ★ 引擎级长流程测试 ★（审计遗留项：限时提问→超时跳过→全流程闭环）
 * mock 掉 Prisma(@/lib/db) 与 LLM(@/core/llm/client)，用假定时器驱动
 * GameEngine 从 READING 一路走到 ENDED，覆盖：
 *  - 真人限时：自我介绍/搜证/圆桌/投票的超时自动处理（含提问后重挂超时的回归）
 *  - AI 全部决策路径的兜底（选点/公开/提问/投票/私聊拒绝）
 *  - 2/2 轮数配置完整走完两轮讨论（M5 回归）
 *  - 终局：reveal 事件 + ENDED + 房间结算
 */

const hoisted = vi.hoisted(() => {
  const tables = { rooms: [] as any[], games: [] as any[], events: [] as any[], seatStates: [] as any[], votes: [] as any[] };
  let seq = BigInt(0);
  const gameRows = new Map<string, any>();
  return {
    tables,
    calls: { gameUpdate: 0, roomUpdate: 0 },
    nextEventRow(data: any) {
      seq += BigInt(1);
      const row = { seq, ...data, createdAt: new Date() };
      tables.events.push(row);
      return row;
    },
    gameRows,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    room: {
      create: async ({ data }: any) => {
        const row = { id: `room-${hoisted.tables.rooms.length + 1}`, ...data };
        hoisted.tables.rooms.push(row);
        return row;
      },
      update: async ({ data }: any) => {
        hoisted.calls.roomUpdate += 1;
        return { id: "room-1", ...data };
      },
    },
    seat: { create: async ({ data }: any) => ({ id: `seat-${hoisted.tables.seatStates.length + 1}`, ...data }) },
    game: {
      create: async ({ data }: any) => {
        const row = { id: `game-${hoisted.tables.games.length + 1}`, ...data, createdAt: new Date() };
        hoisted.tables.games.push(row);
        hoisted.gameRows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where: { id } }: any) => hoisted.gameRows.get(id) ?? null,
      update: async ({ where: { id }, data }: any) => {
        hoisted.calls.gameUpdate += 1;
        const row = hoisted.gameRows.get(id) ?? { id, roomId: "room-1" };
        Object.assign(row, data);
        return row;
      },
    },
    gameEvent: { create: async ({ data }: any) => hoisted.nextEventRow(data) },
    seatState: {
      create: async ({ data }: any) => {
        hoisted.tables.seatStates.push(data);
        return data;
      },
      upsert: async ({ create }: any) => {
        hoisted.tables.seatStates.push(create);
        return create;
      },
      findMany: async () => hoisted.tables.seatStates,
    },
    vote: { create: async ({ data }: any) => ({ id: `vote-${hoisted.tables.votes.length + 1}`, ...data }) },
  },
}));

vi.mock("@/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm/client")>();
  const speech = "我确认我当时一直待在房间里，哪里都没有去，也什么都没看见。";
  return {
    ...actual,
    chat: vi.fn(async (opts: any) => {
      const last = opts.messages[opts.messages.length - 1].content as string;
      let text = speech;
      if (last.includes('{"location"')) text = JSON.stringify({ location: "书房" });
      else if (last.includes('{"publish"')) text = JSON.stringify({ publish: true });
      else if (last.includes('{"ask"')) text = JSON.stringify({ ask: false });
      else if (last.includes('{"whisper"')) text = JSON.stringify({ whisper: false });
      else if (last.includes('{"suggestions"')) text = JSON.stringify({ suggestions: ["我在场。", "我没见过。", "别问我。"] });
      else if (last.includes('{"target"')) text = JSON.stringify({ target: 2, reason: "嫌疑最大。" });
      return { text, promptTokens: 10, completionTokens: 5, providerName: "mock", modelId: "mock" };
    }),
    chatStream: vi.fn(async function* () {
      const speech = "我确认我当时一直待在房间里，哪里都没有去。";
      yield speech.slice(0, 10);
      yield speech.slice(10);
    }),
    embedTexts: vi.fn(async () => null),
  };
});

import { GameEngine } from "./engine";
import { parseScriptForRuntime } from "@/core/script/compat";

const doc = parseScriptForRuntime(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

function makeRoom() {
  const order = ["qinghe", "suwan", "zhoubo", "baimusen", "luxiaokai"];
  return {
    id: "room-1",
    code: "TST01",
    unlimitedHumanTurns: false, // 限时模式：3 分钟超时(测试用假定时器快进)
    humanDm: false,
    seats: order.map((characterId, index) => ({
      index,
      kind: index === 0 ? "human" : "ai",
      characterId,
      playerName: index === 0 ? "测试真人" : `AI${index}`,
      token: `tok-${index}`,
    })),
  };
}

function eventsOf(engine: GameEngine) {
  return engine.events;
}

async function waitPhase(engine: GameEngine, phase: string, maxMs = 600_000) {
  let waited = 0;
  while (engine.state.phase !== phase && waited < maxMs) {
    await vi.advanceTimersByTimeAsync(10_000);
    waited += 10_000;
  }
  expect(engine.state.phase).toBe(phase);
}

async function runUntilEnded(engine: GameEngine, maxSteps = 60) {
  for (let i = 0; i < maxSteps && engine.state.phase !== "ENDED"; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
  }
  expect(engine.state.phase).toBe("ENDED");
}

describe("引擎长流程(限时模式,1 真人 + 4 AI)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.tables.rooms.length = 0;
    hoisted.tables.games.length = 0;
    hoisted.tables.events.length = 0;
    hoisted.tables.seatStates.length = 0;
    hoisted.tables.votes.length = 0;
    hoisted.calls.gameUpdate = 0;
    hoisted.calls.roomUpdate = 0;
  });

  it("超时跳过 + 真人提问 + AI 全兜底,完整走完两轮讨论并结算", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    const ready = await engine.handleAction(0, { type: "ready" });
    expect(ready.ok).toBe(true); // 真人确认读本;AI 读本走定时器
    expect(engine.state.phase).toBe("READING");

    // AI 读本定时器
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.state.phase).toBe("SELF_INTRO");

    // 轮到真人:自我介绍发言(不点名,避免插话分支)
    expect(engine.state.turnSeat).toBe(0);
    const speak = await engine.handleAction(0, { type: "speak", text: "我一直在房间里，没有离开过。" });
    expect(speak.ok).toBe(true);

    // 超时链路:搜证选点等真人环节由 3 分钟超时自动兜底,直到进入第一轮讨论
    await waitPhase(engine, "DISCUSSION");

    // 讨论:验证提问→AI 作答→提问配额扣减
    const ask = await engine.handleAction(0, { type: "ask", toSeat: 1, text: "案发时你在哪里？" });
    expect(ask.ok).toBe(true);
    expect(engine.state.questionsLeft["0"]).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.state.pendingAnswer).toBeNull();
    expect(eventsOf(engine).some((e) => e.type === "speech" && e.fromSeat === 1)).toBe(true);

    // 其余环节(其余座位发言、第二轮搜证讨论、投票)由超时兜底与 AI 决策自动推进
    await runUntilEnded(engine);

    // 终局断言
    const events = eventsOf(engine);
    expect(events.some((e) => e.type === "reveal")).toBe(true);
    expect(events.some((e) => e.type === "phase" && e.content.phase === "ENDED")).toBe(true);
    expect(engine.state.voteResult).not.toBeNull();
    expect(hoisted.calls.gameUpdate).toBeGreaterThan(0);
    // 房间结算
    expect(hoisted.calls.roomUpdate).toBeGreaterThan(0);
  }, 120_000);

  it("真人提问后挂机:ensureHumanTimeout 重新武装,3 分钟后自动跳过(限时提问回归)", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    const ready = await engine.handleAction(0, { type: "ready" });
    expect(ready.ok).toBe(true); // 真人确认读本;AI 读本走定时器
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.state.phase).toBe("SELF_INTRO");

    // 走完自我介绍与第一轮搜证,进入讨论后再提问(ask 仅限讨论阶段)
    await waitPhase(engine, "DISCUSSION");

    // 真人提问 AI(提交问题会清掉提问者的超时定时器)
    const ask = await engine.handleAction(0, { type: "ask", toSeat: 2, text: "当晚你的行踪是什么？" });
    expect(ask.ok).toBe(true);
    expect(engine.state.pendingAnswer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine.state.pendingAnswer).toBeNull(); // AI 已作答

    // 关键回归:提问者的超时必须被重新武装——3 分钟挂机后自动跳过,流程不得卡死
    const before = engine.state.spokenSeats.length;
    await vi.advanceTimersByTimeAsync(181_000);
    const timeoutEvent = eventsOf(engine).find((e) => e.type === "system" && String(e.content.text ?? "").includes("自动跳过"));
    expect(timeoutEvent).toBeTruthy();
    expect(engine.state.spokenSeats.length).toBeGreaterThan(before);
    expect(engine.state.turnSeat).not.toBe(0); // 已轮到下一位

    await runUntilEnded(engine);
  }, 120_000);

  it("2/2 轮数配置:两轮讨论完整发生(M5 回归)", async () => {
    expect(doc.flow.searchRounds).toBe(2);
    expect(doc.flow.discussionRounds).toBe(2);
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    const ready = await engine.handleAction(0, { type: "ready" });
    expect(ready.ok).toBe(true); // 真人确认读本;AI 读本走定时器
    await runUntilEnded(engine);
    const discussionRounds = new Set(
      eventsOf(engine).filter((e) => e.type === "phase" && e.content.phase === "DISCUSSION").map((e) => e.round),
    );
    expect(discussionRounds.has(1)).toBe(true);
    expect(discussionRounds.has(2)).toBe(true);
  }, 120_000);
});
