import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_LINE, seedScript, seats1h2a, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";
import { db } from "@/lib/db";
import { GameEngine } from "./engine";
import { subscribe } from "./bus";
import { engines, engineLoads } from "./registry";
import { appendEvent } from "./state";
import type { EngineEvent } from "./types";

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
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_reject_game_snapshot_update" ON "games"');
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_reject_game_snapshot_update_fn"()');
  await teardownIntEnv();
});

async function startEngine(code: string): Promise<GameEngine> {
  const script = await seedScript();
  const scriptRow = await db.script.findUnique({ where: { id: script.id } });
  const room = await db.room.create({
    data: {
      code,
      scriptId: script.id,
      status: "lobby",
      hostToken: "host-token-1",
      seats: {
        create: seats1h2a().map((seat, index) => ({
          index,
          kind: seat.kind,
          characterId: seat.characterId,
          playerName: seat.kind === "human" ? "真人大佬" : null,
          token: seat.kind === "human" ? "seat-token-1" : null,
        })),
      },
    },
    include: { seats: true },
  });
  const engine = await GameEngine.start(room as never, { id: script.id, content: scriptRow!.content });
  engine.clearTimers();
  return engine;
}

describe("L3：事件与状态快照原子写（I05）", () => {
  it("快照更新失败时回滚事件、内存事件与总线都不前进", async () => {
    const engine = await startEngine("ATM01");
    const unsubscribe = subscribe(engine.gameId, () => {
      throw new Error("不应广播未提交事件");
    });
    const eventsBefore = await db.gameEvent.count({ where: { gameId: engine.gameId } });
    const memoryBefore = engine.events.length;

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "test_reject_game_snapshot_update_fn"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected snapshot failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "test_reject_game_snapshot_update"
      BEFORE UPDATE ON "games"
      FOR EACH ROW EXECUTE FUNCTION "test_reject_game_snapshot_update_fn"()
    `);

    try {
      await expect(engine.recordEvent({
        type: "system",
        phase: engine.state.phase,
        round: engine.state.round,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { text: "该事件不得部分提交" },
      })).rejects.toThrow("injected snapshot failure");
      expect(await db.gameEvent.count({ where: { gameId: engine.gameId } })).toBe(eventsBefore);
      expect(engine.events).toHaveLength(memoryBefore);
    } finally {
      unsubscribe();
    }
  }, 60_000);

  it("recordEvent 后立即模拟崩溃，重新 load 从快照恢复该事件对应的状态", async () => {
    const engine = await startEngine("ATM02");
    engine.state.phase = "LOBBY";
    engine.state.round = 2;
    engine.state.heldClues[0] = ["clue-after-event"];
    engine.state.clueStates["clue-after-event"] = { discoveredBy: 0, isPublic: false };

    await engine.recordEvent({
      type: "system",
      phase: "LOBBY",
      round: 2,
      fromSeat: 0,
      toSeat: null,
      visibility: "public",
      content: { marker: "snapshot-after-event" },
    });
    const eventCount = await db.gameEvent.count({ where: { gameId: engine.gameId } });

    // 模拟进程丢失：清 registry，不调用 persist()，由另一份引擎实例重新加载。
    engine.clearTimers();
    engines.clear();
    engineLoads.clear();
    const restored = await GameEngine.load(engine.gameId);
    restored.drive = false;
    restored.clearTimers();
    await restored.exclusive(async () => undefined);
    expect(restored.state.phase).toBe("LOBBY");
    expect(restored.state.round).toBe(2);
    expect(restored.state.heldClues[0]).toEqual(["clue-after-event"]);
    expect(restored.state.clueStates["clue-after-event"]).toEqual({ discoveredBy: 0, isPublic: false });
    expect(restored.events.some((event) => event.content.marker === "snapshot-after-event")).toBe(true);
    expect(await db.gameEvent.count({ where: { gameId: engine.gameId } })).toBe(eventCount);
    expect((await db.game.findUnique({ where: { id: engine.gameId } }))?.phase).toBe("LOBBY");
  }, 60_000);

  it("记录旧写法与原子写平均耗时及典型快照大小", async () => {
    const engine = await startEngine("ATM03");
    const sample: Omit<EngineEvent, "seq" | "createdAt"> & { content: Record<string, unknown> } = {
      type: "system",
      phase: engine.state.phase,
      round: engine.state.round,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: { text: "原子写基准采样" },
    };
    const oldWriteMs: number[] = [];
    const atomicWriteMs: number[] = [];
    const stateBytes: number[] = [];
    const runs = 30;

    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      await appendEvent(engine.gameId, sample);
      oldWriteMs.push(performance.now() - started);
    }
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      await appendEvent(engine.gameId, sample, engine.state);
      atomicWriteMs.push(performance.now() - started);
      stateBytes.push(Buffer.byteLength(JSON.stringify(engine.state)));
    }

    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const sortedBytes = stateBytes.toSorted((a, b) => a - b);
    const p95Bytes = sortedBytes[Math.ceil(sortedBytes.length * 0.95) - 1];
    const beforeMs = average(oldWriteMs);
    const afterMs = average(atomicWriteMs);
    console.info(`[S4.2 benchmark] event-only avg=${beforeMs.toFixed(2)}ms; atomic avg=${afterMs.toFixed(2)}ms; delta=${(afterMs - beforeMs).toFixed(2)}ms; state JSON p95=${p95Bytes} bytes`);
    expect(afterMs - beforeMs).toBeLessThan(20);
    expect(p95Bytes).toBeLessThan(200_000);
  }, 60_000);
});
