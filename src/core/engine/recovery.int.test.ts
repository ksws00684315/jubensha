import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_LINE, seedScript, seats1h2a, setupIntEnv, truncateAll } from "@/test/int";
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
afterEach(() => {
  // 清掉常驻引擎的全部定时器，避免跨文件竞态与挂起
  for (const e of engines.values()) e.clearTimers();
  engines.clear();
  engineLoads.clear();
});

describe("L3：引擎重启恢复（I06）", () => {
  // 偏差说明：推进到 DISCUSSION 走「引擎真实 start → 真人 ready/speak 走真实动作链 → 状态快进」。
  // fake timers 下引擎定时器链在测试环境不收敛（台账 FIND-02），本用例被测对象是「重启恢复的
  // 等价性」而非完整流程推进（后者由 R1 实机冒烟覆盖）。
  it("I06 start → 推进到 DISCUSSION → 清空 registry → load 恢复一致并可继续", async () => {
    const script = await seedScript();
    const scriptRow = await db.script.findUnique({ where: { id: script.id } });
    const room = await db.room.create({
      data: {
        code: "RST01",
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
    expect(engine.state.phase).toBe("READING");

    // 真人「读完」走真实动作链（事件落库、seatState 更新）
    const readyRes = await engine.handleAction(0, { type: "ready" } as never);
    expect(readyRes.ok).toBe(true);
    // 等互斥队列与定时器链结算，避免与异步 tick 竞态
    await new Promise((r) => setTimeout(r, 300));

    // 快进到 DISCUSSION 后真人发言（真实动作链），产生可对比的事件与状态
    engine.state.phase = "DISCUSSION";
    engine.state.round = 1;
    engine.state.turnSeat = 0;
    engine.state.spokenSeats = [];
    const speakRes = await engine.handleAction(0, { type: "speak", text: "讨论开始：谁最后见到死者的？" } as never);
    expect(speakRes.ok).toBe(true);
    expect(engine.state.phase).toBe("DISCUSSION");

    const memoryPhase = engine.state.phase;
    const memoryRound = engine.state.round;
    const memoryTurnSeat = engine.state.turnSeat;
    const memoryHeld = JSON.parse(JSON.stringify(engine.state.heldClues));
    const memoryClueStates = JSON.parse(JSON.stringify(engine.state.clueStates));
    const memoryEvents = engine.events.map((e) => e.seq);

    // 模拟重启：清空常驻注册表后从 DB 重新加载
    engines.clear();
    engineLoads.clear();
    const restored = await GameEngine.load(engine.gameId);
    expect(restored).not.toBe(engine);
    expect(restored.state.phase).toBe(memoryPhase);
    expect(restored.state.round).toBe(memoryRound);
    expect(restored.state.turnSeat).toBe(memoryTurnSeat);
    expect(restored.state.heldClues).toEqual(memoryHeld);
    expect(restored.state.clueStates).toEqual(memoryClueStates);
    // 最近事件已回放进内存
    expect(restored.events.map((e) => e.seq)).toEqual(memoryEvents);

    // 恢复后可继续推进：真人发言产生新事件，对局仍在进行
    restored.state.turnSeat = 0;
    const eventsBefore = await db.gameEvent.count({ where: { gameId: engine.gameId } });
    await restored.handleAction(0, { type: "speak", text: "恢复后的第一句发言。" } as never);
    const eventsAfter = await db.gameEvent.count({ where: { gameId: engine.gameId } });
    expect(eventsAfter).toBeGreaterThan(eventsBefore);
    expect(restored.state.phase).toBe("DISCUSSION");
  }, 120_000);
});
