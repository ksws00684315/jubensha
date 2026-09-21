/**
 * 引擎长流程集成测试:mock Prisma 与 LLM。
 * mock 层大量使用 any 以简化 Prisma 形状伪装,故对本文件豁免 no-explicit-any。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
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
  const hang = { stream: false, chat: false };
  let releaseStream: (() => void) | null = null;
  const tables = { rooms: [] as any[], games: [] as any[], events: [] as any[], seatStates: [] as any[], votes: [] as any[] };
  const calls = { chatStream: 0 };
  let seq = BigInt(0);
  const gameRows = new Map<string, any>();
  return {
    tables,
    calls: { gameUpdate: 0, roomUpdate: 0 },
    llmCalls: calls,
    nextEventRow(data: any) {
      seq += BigInt(1);
      const row = { seq, ...data, createdAt: new Date() };
      tables.events.push(row);
      return row;
    },
    gameRows,
    hang,
    get releaseStream() { return releaseStream; },
    set releaseStream(value: (() => void) | null) { releaseStream = value; },
    // AI 私信决策开关:null=拒绝;设为 {to,text} 则 AI 向该真人开窗（to 为 1 基座位号）
    whisperDecision: null as { to: number; text: string } | null,
  };
});

vi.mock("@/lib/db", () => {
  const db = {
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
    gameEvent: {
      create: async ({ data }: any) => hoisted.nextEventRow(data),
      count: async ({ where: { gameId } }: any) => hoisted.tables.events.filter((e) => e.gameId === gameId).length,
      findMany: async ({ where: { gameId }, orderBy, take }: any) => {
        const rows = hoisted.tables.events.filter((e) => e.gameId === gameId);
        const desc = String(orderBy?.seq ?? "") === "desc";
        const sorted = rows.sort((a, b) => (desc ? Number(b.seq - a.seq) : Number(a.seq - b.seq)));
        return take ? sorted.slice(0, take) : sorted;
      },
    },
    seatState: {
      create: async ({ data }: any) => {
        hoisted.tables.seatStates.push(data);
        return data;
      },
      createMany: async ({ data }: any) => {
        for (const row of data) hoisted.tables.seatStates.push(row);
        return { count: data.length };
      },
      upsert: async ({ create }: any) => {
        hoisted.tables.seatStates.push(create);
        return create;
      },
      findMany: async () => hoisted.tables.seatStates,
    },
    vote: { create: async ({ data }: any) => ({ id: `vote-${hoisted.tables.votes.length + 1}`, ...data }) },
    $transaction: async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(db)),
  };
  return { db };
});

vi.mock("@/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm/client")>();
  const speech = "我确认我当时一直待在房间里，哪里都没有去，也什么都没看见。";
  return {
    ...actual,
    chat: vi.fn(async (opts: any) => {
      if (hoisted.hang.chat) await new Promise(() => {});
      const last = opts.messages[opts.messages.length - 1].content as string;
      let text = speech;
      if (last.includes('{"location"')) text = JSON.stringify({ location: "书房" });
      else if (last.includes('{"publish"')) text = JSON.stringify({ publish: true });
      else if (last.includes('{"ask"')) text = JSON.stringify({ ask: false });
      else if (last.includes('{"whisper"')) text = hoisted.whisperDecision ? JSON.stringify({ whisper: true, ...hoisted.whisperDecision }) : JSON.stringify({ whisper: false });
      else if (last.includes('{"suggestions"')) text = JSON.stringify({ suggestions: ["我在场。", "我没见过。", "别问我。"] });
      else if (last.includes('{"target"')) text = JSON.stringify({ target: 2, reason: "嫌疑最大。" });
      return { text, promptTokens: 10, completionTokens: 5, providerName: "mock", modelId: "mock" };
    }),
    chatStream: vi.fn(async function* () {
      hoisted.llmCalls.chatStream += 1;
      if (hoisted.hang.stream) await new Promise<void>((resolve) => { hoisted.releaseStream = resolve; });
      const speech = "我确认我当时一直待在房间里，哪里都没有去。";
      yield speech.slice(0, 10);
      yield speech.slice(10);
    }),
    embedTexts: vi.fn(async () => null),
  };
});

import { GameEngine } from "./engine";
import { maybeQueueWhisper, maybeQueueInterjection } from "./social";
import { tallyVotes, transitionSelfIntro } from "./phases";
import { dispatchClues } from "./search-deal";
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
    hoisted.llmCalls.chatStream = 0;
    hoisted.releaseStream = null;
  });

  it("正式问题取消排队插话，问题与唯一回答共享 ID", async () => {
    const e = await GameEngine.start(makeRoom() as any, { id: "script-q", content: JSON.parse(JSON.stringify(doc)) });
    e.clearTimers(""); e.turnInFlight = false; e.state.phase = "DISCUSSION"; e.state.round = 1; e.state.turnSeat = 0; e.state.questionsLeft = { "0": 3 };
    maybeQueueInterjection(e, 0, "苏晚，你当时在哪里？");
    expect((await e.handleAction(0, { type: "ask", toSeat: 1, text: "苏晚，你当时在哪里？" })).ok).toBe(true);
    const id = e.state.pendingAnswer?.questionId;
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.events.filter((event) => event.content.answer && event.content.questionId === id)).toHaveLength(1);
    expect(e.events.filter((event) => event.content.interjection)).toHaveLength(0);
    e.clearTimers("");
  });

  it("真人投票必须引用合法公开证据，非法和私密引用被拒绝", async () => {
    const e = await GameEngine.start(makeRoom() as any, { id: "script-v", content: JSON.parse(JSON.stringify(doc)) });
    e.clearTimers(""); e.state.phase = "VOTE";
    const clueId = doc.clues[0].id;
    e.state.clueStates[clueId] = { isPublic: true, discoveredBy: 0 };
    expect((await e.handleAction(0, { type: "vote", target: 1, evidenceIds: ["hidden"] })).ok).toBe(false);
    expect((await e.handleAction(0, { type: "vote", target: 1, evidenceIds: [clueId, "hidden"] })).ok).toBe(true);
    expect(e.state.votes["0"].evidenceIds).toEqual([clueId]);
    expect(e.events.find((event) => event.type === "vote")?.content.evidenceIds).toEqual([clueId]);
    e.clearTimers("");
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

  it("终局复盘生成在途时重复 tick 不会触发 200 步空转", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    await vi.advanceTimersByTimeAsync(500); // 让开场旁白完成

    engine.state.phase = "REVEAL";
    engine.state.voteResult = { counts: { "0": 1 }, culpritSeat: 0, caught: true };
    hoisted.hang.stream = true;
    await engine.tick();
    await vi.advanceTimersByTimeAsync(50); // 终局 DM 生成开始并挂起

    await engine.tick(); // 模拟投票完成时已排队的重复 tick

    expect(eventsOf(engine).filter((event) => event.type === "system" && event.content.text?.includes("超过 200 步"))).toHaveLength(0);
    expect(engine.state.phase).toBe("REVEAL");
    hoisted.hang.stream = false;
    hoisted.releaseStream?.();
    await vi.advanceTimersByTimeAsync(1000);

    const events = eventsOf(engine);
    expect(events.filter((event) => event.type === "reveal")).toHaveLength(1);
    expect(events.filter((event) => event.type === "phase" && event.content.phase === "ENDED")).toHaveLength(1);
    const narrationIndex = events.findIndex((event) => event.type === "phase" && event.phase === "REVEAL" && Boolean(event.content.text));
    const revealIndex = events.findIndex((event) => event.type === "reveal");
    const endedIndex = events.findIndex((event) => event.type === "phase" && event.content.phase === "ENDED");
    expect(narrationIndex).toBeLessThan(revealIndex);
    expect(revealIndex).toBeLessThan(endedIndex);
    await engine.tick();
    expect(eventsOf(engine).filter((event) => event.type === "reveal")).toHaveLength(1);
  }, 30_000);

  it("无限真人时间下连续推进只向真人发送一次读本提示", async () => {
    const room = { ...makeRoom(), unlimitedHumanTurns: true };
    const engine = await GameEngine.start(room as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    await vi.advanceTimersByTimeAsync(100);
    await engine.tick();
    await engine.tick();
    await engine.tick();

    expect(eventsOf(engine).filter((event) => event.type === "system" && event.visibility === "seat:0" && event.content.text?.includes("请阅读角色剧本"))).toHaveLength(1);
  }, 30_000);

  it("常规阶段切换使用模板，不再额外调用 AI 主持", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    await vi.advanceTimersByTimeAsync(500);
    expect(hoisted.llmCalls.chatStream).toBe(1); // 只有开场由 AI 主持

    await transitionSelfIntro(engine);

    expect(hoisted.llmCalls.chatStream).toBe(1);
    expect(eventsOf(engine).some((event) => event.type === "phase" && event.phase === "SELF_INTRO" && event.content.text?.startsWith("进入【自我介绍】"))).toBe(true);
  }, 30_000);

  it("同一地点多人搜证时，一张线索最多交给一个座位", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    const location = doc.locations.find((candidate) => doc.clues.some((clue) => clue.locationId === candidate.id && !clue.forbiddenCharacterIds.includes("qinghe")))!;
    engine.state.phase = "SEARCH";
    engine.state.round = 1;
    engine.state.searchChoices = { "0": location.name, "1": location.name, "2": "__no_search__", "3": "__no_search__", "4": "__no_search__" };

    await dispatchClues(engine);

    const held = Object.values(engine.state.heldClues).flat();
    expect(new Set(held).size).toBe(held.length);
    expect(Object.values(engine.state.clueStates).filter((clue) => clue.discoveredBy !== null).length).toBe(new Set(held).size);
  }, 30_000);

  it("座位没有任何可搜材料时自动完成搜证，不会要求选耗尽地点", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    engine.state.phase = "SEARCH";
    engine.state.round = 1;
    engine.state.clueStates = Object.fromEntries(doc.clues.map((clue) => [clue.id, { discoveredBy: null, isPublic: true }]));

    await engine.tick();
    expect(Object.values(engine.state.searchChoices)).toHaveLength(5);
    expect(Object.values(engine.state.searchChoices).every((choice) => choice === "__no_search__")).toBe(true);
    await engine.tick();
    expect(engine.state.phase).toBe("DISCUSSION");
  }, 30_000);

  it("后端拒绝搜自己的房间", async () => {
    const scripted = structuredClone(doc);
    scripted.locations.push({ id: "qinghe_room", name: "清河的房间", ownerCharacterId: "qinghe", description: [] });
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(scripted)) });
    engine.state.phase = "SEARCH";
    engine.state.round = 1;

    const result = await engine.handleAction(0, { type: "choose_location", location: "清河的房间" });

    expect(result).toMatchObject({ ok: false, error: "你不能搜自己的房间" });
  }, 30_000);
});

describe("回合执行器(审计 M6 核心回归)", () => {
  beforeEach(() => {
    hoisted.hang.stream = false;
    hoisted.hang.chat = false;
  });

  it("AI 思考期间真人动作立即可用,不被 LLM 阻塞;看门狗超时后强制推进", async () => {
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    const ready = await engine.handleAction(0, { type: "ready" });
    expect(ready.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.state.phase).toBe("SELF_INTRO");

    // 真人发言后轮到 AI;让 LLM 挂起,制造"回合在飞"
    const speak = await engine.handleAction(0, { type: "speak", text: "我一直在房间里，没有离开过。" });
    expect(speak.ok).toBe(true);
    hoisted.hang.stream = true;
    hoisted.hang.chat = true;
    await vi.advanceTimersByTimeAsync(200); // AI 回合 dispatch(30ms)后 produce 挂起

    // 核心断言:挂起的 LLM 不得阻塞真人动作(旧实现会把整个 handleAction 卡在互斥锁里)
    let resolved = false;
    const p = engine.handleAction(0, { type: "rush" }).then((r) => {
      resolved = true;
      return r;
    });
    for (let i = 0; i < 200 && !resolved; i++) await Promise.resolve();
    expect(resolved).toBe(true);
    const rushResult = await p;
    expect(rushResult.ok).toBe(true);

    // 看门狗:2×90s+5s 后强制跳过挂起的回合,流程继续
    await vi.advanceTimersByTimeAsync(200_000);
    expect(engine.state.spokenSeats.includes(1)).toBe(true);

    // 解除挂起,其余流程正常走完
    hoisted.hang.stream = false;
    hoisted.hang.chat = false;
    await runUntilEnded(engine);
    expect(engine.state.voteResult).not.toBeNull();
  }, 120_000);
});

describe("剧本开关接线(批次 F)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.hang.stream = false;
    hoisted.hang.chat = false;
    hoisted.whisperDecision = null;
    hoisted.tables.rooms.length = 0;
    hoisted.tables.games.length = 0;
    hoisted.tables.events.length = 0;
    hoisted.tables.seatStates.length = 0;
    hoisted.tables.votes.length = 0;
  });

  /** 推进到第一轮讨论(真人只发一次自我介绍言,其余靠超时与 AI 自动) */
  async function startInDiscussion(engine: GameEngine) {
    await engine.handleAction(0, { type: "ready" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.state.phase).toBe("SELF_INTRO");
    const speak = await engine.handleAction(0, { type: "speak", text: "我是住客，案发前在大厅烤火。" });
    expect(speak.ok).toBe(true);
    await waitPhase(engine, "DISCUSSION");
  }

  it("selfIntroRounds=2:自我介绍完整跑两轮后才进入搜证", async () => {
    const docClone = JSON.parse(JSON.stringify(doc));
    docClone.flow.selfIntroRounds = 2;
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: docClone });
    await engine.handleAction(0, { type: "ready" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(engine.state.phase).toBe("SELF_INTRO");
    await engine.handleAction(0, { type: "speak", text: "第一轮：我是住客。" });

    for (let i = 0; i < 30 && !(engine.state.phase === "SELF_INTRO" && engine.state.round === 2); i++) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(engine.state.phase).toBe("SELF_INTRO");
    expect(engine.state.round).toBe(2);
    expect(engine.state.turnSeat).toBe(0);
    expect(engine.state.spokenSeats.length).toBe(0); // 新一轮重新计名

    await engine.handleAction(0, { type: "speak", text: "第二轮：我没上过二楼。" });
    await waitPhase(engine, "SEARCH");
    const introRounds = new Set(
      eventsOf(engine).filter((e) => e.type === "phase" && e.content.phase === "SELF_INTRO").map((e) => e.round),
    );
    expect(introRounds.has(2)).toBe(true);
  }, 120_000);

  it("allowPrivateChat=false:AI 私信不派发,真人回复通道被拦截", async () => {
    const docClone = JSON.parse(JSON.stringify(doc));
    docClone.flow.allowPrivateChat = false;
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: docClone });
    await startInDiscussion(engine);
    hoisted.whisperDecision = { to: 1, text: "悄悄说一句。" };

    (engine as any).whisperAsked.clear(); // 讨论中 AI 发言已自然占用过记忆位,先重置
    await maybeQueueWhisper(engine, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.state.privateChat["1-0"]).toBeUndefined(); // 开关关闭时不开窗

    const reply = await engine.handleAction(0, { type: "private_chat", toSeat: 1, text: "回复" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("未开放私聊");
  }, 120_000);

  it("allowPrivateChat=true:开窗口封顶 limit,真人回复逐次消耗、耗尽封口", async () => {
    expect(doc.flow.allowPrivateChat).toBe(true);
    expect(doc.flow.privateChatMessageLimit).toBe(3);
    const engine = await GameEngine.start(makeRoom() as any, { id: "script-1", content: JSON.parse(JSON.stringify(doc)) });
    await startInDiscussion(engine);
    hoisted.whisperDecision = { to: 1, text: "这条你白天没敢当众说。" };

    (engine as any).whisperAsked.clear(); // 讨论中 AI 发言已自然占用过记忆位,先重置
    await maybeQueueWhisper(engine, 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.state.privateChat["1-0"]).toBe(1);

    // 同一窗口反复私信:额度封顶 privateChatMessageLimit=3,不无限累加
    for (let i = 0; i < 4; i++) {
      (engine as any).whisperAsked.clear();
      await maybeQueueWhisper(engine, 1);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(engine.state.privateChat["1-0"]).toBe(3);

    // 真人回复逐次扣减(修正旧实现直接置 0 的一次性语义)
    const r1 = await engine.handleAction(0, { type: "private_chat", toSeat: 1, text: "回复一" });
    expect(r1.ok).toBe(true);
    expect(engine.state.privateChat["1-0"]).toBe(2);
    const r2 = await engine.handleAction(0, { type: "private_chat", toSeat: 1, text: "回复二" });
    expect(r2.ok).toBe(true);
    expect(engine.state.privateChat["1-0"]).toBe(1);
    const r3 = await engine.handleAction(0, { type: "private_chat", toSeat: 1, text: "回复三" });
    expect(r3.ok).toBe(true);
    expect(engine.state.privateChat["1-0"]).toBe(0);
    const r4 = await engine.handleAction(0, { type: "private_chat", toSeat: 1, text: "回复四" });
    expect(r4.ok).toBe(false); // 额度耗尽,窗口封口
    expect(r4.error).toContain("没有向你发起私信");
  }, 120_000);
});

describe("计票判定 tallyVotes（批次 J：平票规则与真凶未入座）", () => {
  it("唯一最高票命中真凶 → 指认成功", () => {
    const r = tallyVotes({ counts: { "2": 3, "1": 2 }, culpritSeat: 2, voteMode: "accuse" });
    expect(r.caught).toBe(true);
    expect(r.tiedSeats).toBeUndefined();
  });
  it("并列最高票 → 平票指认失败，tiedSeats 升序给出", () => {
    const r = tallyVotes({ counts: { "2": 2, "1": 2, "0": 1 }, culpritSeat: 1, voteMode: "accuse" });
    expect(r.caught).toBe(false);
    expect(r.tiedSeats).toEqual([1, 2]);
  });
  it("无人投票且真凶未入座 → 不判「被抓」（旧实现 topSeat/culpritSeat 同为 -1 的误判回归）", () => {
    expect(tallyVotes({ counts: {}, culpritSeat: -1, voteMode: "accuse" }).caught).toBe(false);
    expect(tallyVotes({ counts: {}, culpritSeat: 0, voteMode: "accuse" }).caught).toBe(false);
  });
  it("票全投给唯一座位但真凶未入座 → caught false", () => {
    const r = tallyVotes({ counts: { "1": 4 }, culpritSeat: -1, voteMode: "accuse" });
    expect(r.caught).toBe(false);
    expect(r.tiedSeats).toBeUndefined();
  });
  it("还原本（choice）不参与指认判定", () => {
    const r = tallyVotes({ counts: { "2": 5 }, culpritSeat: 2, voteMode: "choice" });
    expect(r.caught).toBe(false);
  });
});
