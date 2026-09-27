import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_LINE, seedScript, seats1h2a, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";
import { db } from "@/lib/db";
import { GameEngine } from "./engine";
import { engines, engineLoads } from "./registry";

// LLM 一律 mock：固定台词，不发真实请求
vi.mock("@/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm/client")>();
  return {
    ...actual,
    chat: vi.fn(async () => ({ text: LLM_LINE })) as never,
    chatStream: vi.fn(async function* () {
      yield LLM_LINE;
    }) as never,
    embedTexts: vi.fn(async () => null),
  };
});

beforeEach(async () => {
  await setupIntEnv();
  await truncateAll();
});
afterEach(async () => {
  await teardownIntEnv();
});

async function startTestEngine(): Promise<{ engine: GameEngine; gameId: string; scriptId: string }> {
  const script = await seedScript();
  const scriptRow = await db.script.findUnique({ where: { id: script.id } });
  const room = await db.room.create({
    data: {
      code: "RST02",
      scriptId: script.id,
      status: "lobby",
      hostToken: "host-token-1",
      seats: {
        create: seats1h2a().map((s, index) => ({
          index,
          kind: s.kind,
          characterId: s.characterId,
          playerName: s.kind === "human" ? "真人大佬" : null,
          token: s.kind === "human" ? "seat-token-1" : null,
        })),
      },
    },
    include: { seats: true },
  });
  const engine = await GameEngine.start(room as never, { id: script.id, content: scriptRow!.content });
  await engine.handleAction(0, { type: "ready" } as never);
  await new Promise((r) => setTimeout(r, 300));
  // 停掉 AI 介绍轮等后台定时器：后续用例对事件/状态做精确对比，不允许异步写入干扰
  engine.clearTimers();
  return { engine, gameId: engine.gameId, scriptId: script.id };
}

/** 状态快进到指定阶段并结算（persist），模拟对局推进到该恢复点。 */
async function fastForwardTo(
  engine: GameEngine,
  phase: "SEARCH" | "VOTE" | "REVEAL",
  patch: (e: GameEngine) => void | Promise<void>
): Promise<void> {
  engine.state.phase = phase;
  engine.state.round = 1;
  engine.state.turnSeat = null;
  engine.state.spokenSeats = [];
  await patch(engine);
  await engine.persist();
}

async function reloadFromDb(gameId: string): Promise<GameEngine> {
  engines.clear();
  engineLoads.clear();
  return GameEngine.load(gameId);
}

describe("L3：恢复点变体（I06 扩展）", () => {
  it("SEARCH 中途（部分座位已选点）重启后恢复一致", async () => {
    const { engine, gameId } = await startTestEngine();
    await fastForwardTo(engine, "SEARCH", async (e) => {
      e.state.searchChoices = { "0": "值班室", "1": "码头仓库" };
      e.state.searchDealtRound = 0;
      e.state.clueStates = { "c-1": { discoveredBy: 0, isPublic: false } };
      e.state.pendingPublish = { "0": ["c-1"] };
    });
    const memory = JSON.parse(JSON.stringify({ choices: engine.state.searchChoices, pending: engine.state.pendingPublish, clues: engine.state.clueStates, phase: engine.state.phase, round: engine.state.round }));
    const restored = await reloadFromDb(gameId);
    expect(restored.state.phase).toBe(memory.phase);
    expect(restored.state.round).toBe(memory.round);
    expect(restored.state.searchChoices).toEqual(memory.choices);
    expect(restored.state.pendingPublish).toEqual(memory.pending);
    expect(restored.state.clueStates).toEqual(memory.clues);
  }, 60_000);

  it("VOTE 中途（部分座位已投）重启后恢复一致", async () => {
    const { engine, gameId } = await startTestEngine();
    await fastForwardTo(engine, "VOTE", (e) => {
      e.state.votes = { "0": { target: 1, reason: "时间线对不上" } };
      e.state.pendingAnswer = null;
    });
    const memory = JSON.parse(JSON.stringify(engine.state.votes));
    const restored = await reloadFromDb(gameId);
    expect(restored.state.phase).toBe("VOTE");
    expect(restored.state.votes).toEqual(memory);
  }, 60_000);

  it("REVEAL（全员已投）重启后恢复一致，且继续推进可达 ENDED", async () => {
    const { engine, gameId } = await startTestEngine();
    await fastForwardTo(engine, "REVEAL", (e) => {
      e.state.votes = { "0": { target: 1, reason: "a" }, "1": { target: 1, reason: "b" }, "2": { target: 1, reason: "c" } };
      // transitionVote 会在进 REVEAL 前算好票型；这里直接给出与投票一致的票型
      e.state.voteResult = { counts: { "1": 3 }, culpritSeat: 1, caught: true };
    });
    const restored = await reloadFromDb(gameId);
    expect(restored.state.phase).toBe("REVEAL");
    // resumeAfterLoad 会自动 tick：结算走真实代码链（LLM 已 mock），最终到达 ENDED
    const deadline = Date.now() + 30_000;
    while (restored.state.phase !== "ENDED" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(restored.state.phase).toBe("ENDED");
    const dbPhase = (await db.game.findUnique({ where: { id: gameId } }))?.phase;
    expect(dbPhase).toBe("ENDED");
  }, 90_000);
});

describe("L3：并发动作与互斥", () => {
  // 偏差说明（以代码为准）：计划预期放在 DISCUSSION，但该阶段 speak 不做回合推进——
  // 圆桌自由发言是现网既有语义（engine.ts DISCUSSION speak 分支不调 markSpoken）。
  // 回合门禁语义在 SELF_INTRO 上成立，故此处用 SELF_INTRO 验证并发只记 1 条。
  it("同一座位并发提交 2 个 speak（SELF_INTRO）：只记录 1 条发言", async () => {
    const { engine } = await startTestEngine();
    engine.state.phase = "SELF_INTRO";
    engine.state.round = 1;
    engine.state.turnSeat = 0;
    engine.state.spokenSeats = [];
    const [a, b] = await Promise.all([
      engine.handleAction(0, { type: "speak", text: "第一句并发发言。" } as never),
      engine.handleAction(0, { type: "speak", text: "第二句并发发言。" } as never),
    ]);
    const oks = [a.ok, b.ok];
    oks.sort();
    expect(oks).toEqual([false, true]); // 恰好一个成功
    const speeches = await db.gameEvent.findMany({ where: { gameId: engine.gameId, type: "speech", fromSeat: 0 } });
    expect(speeches).toHaveLength(1);
    expect(speeches[0].content).toMatchObject({ text: expect.stringMatching(/第一句|第二句/) });
  }, 60_000);

  it("handleAction 与定时器 tick 交错执行：互斥下事件 seq 唯一、状态一致", async () => {
    const { engine } = await startTestEngine();
    engine.state.phase = "DISCUSSION";
    engine.state.round = 1;
    engine.state.turnSeat = 0;
    engine.state.spokenSeats = [];
    // 定时器任务（引擎内部与动作同一互斥队列）
    engine.schedule("probe-reminder", async () => {
      await engine.systemSay("（提醒：请尽快发言。）");
    }, 20);
    await Promise.all([
      engine.handleAction(0, { type: "speak", text: "与定时器交错的发言。" } as never),
      new Promise((r) => setTimeout(r, 60)),
    ]);
    void engine.clearTimers();
    const events = await db.gameEvent.findMany({ where: { gameId: engine.gameId }, orderBy: { seq: "asc" } });
    const seqs = events.map((e) => e.seq.toString());
    expect(new Set(seqs).size).toBe(seqs.length); // seq 唯一
    const seqNums = seqs.map(Number).sort((a, b) => a - b);
    expect(seqNums).toEqual([...new Set(seqNums)].sort((a, b) => a - b)); // 无重复
    expect(engine.state.phase).toBe("DISCUSSION");
    expect(engine.state.pendingAnswer).toBeNull();
  }, 60_000);
});
