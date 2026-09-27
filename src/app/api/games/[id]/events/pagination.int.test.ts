import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { seedScript, seats1h2a, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";

vi.mock("@/core/engine/engine", () => ({ GameEngine: { get: vi.fn(() => null), load: vi.fn(async () => ({})) } }));

beforeEach(async () => {
  await setupIntEnv();
  await truncateAll();
});
afterEach(async () => {
  await teardownIntEnv();
});

describe("L3：SSE 历史回放分页（I10）", () => {
  it("I10 回放 5,000 条事件并按 seq 顺序完整返回，分页峰值低于一次性读取一半", async () => {
    const script = await seedScript();
    const room = await db.room.create({
      data: {
        code: "PAG01",
        scriptId: script.id,
        status: "started",
        hostToken: "host-token-1",
        seats: { create: seats1h2a().map((seat, index) => ({ index, kind: seat.kind, characterId: seat.characterId })) },
      },
    });
    const game = await db.game.create({
      data: { roomId: room.id, scriptId: script.id, status: "running", phase: "DISCUSSION", round: 1, state: {} },
    });

    const payload = "x".repeat(2_048);
    await db.gameEvent.createMany({
      data: Array.from({ length: 5_000 }, (_, index) => ({
        gameId: game.id,
        type: "system",
        phase: "DISCUSSION",
        round: 1,
        visibility: "public",
        content: { text: `${index}:${payload}` },
      })),
    });

    async function measureUnpagedHeapDelta(): Promise<number> {
      const before = process.memoryUsage().heapUsed;
      const events = await db.gameEvent.findMany({ where: { gameId: game.id }, orderBy: { seq: "asc" } });
      const delta = process.memoryUsage().heapUsed - before;
      expect(events).toHaveLength(5_000);
      return delta;
    }

    const unpagedHeapDelta = await measureUnpagedHeapDelta();
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    expect(gc).toBeTypeOf("function");
    gc?.();
    const pagedStart = process.memoryUsage().heapUsed;
    let pagedPeak = pagedStart;
    const { GET } = await import("./route");
    const abort = new AbortController();
    const response = await GET(new Request(`http://localhost/api/games/${game.id}/events`, { signal: abort.signal }), { params: Promise.resolve({ id: game.id }) });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventCount = 0;
    let lastSeq = BigInt(0);
    let ordered = true;
    let helloLastSeq: string | null = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!data) continue;
        const message = JSON.parse(data) as { kind: string; event?: { seq: string }; lastSeq?: string };
        if (message.kind === "event" && message.event) {
          const seq = BigInt(message.event.seq);
          if (seq <= lastSeq) ordered = false;
          lastSeq = seq;
          eventCount++;
          if (eventCount % 500 === 0) {
            gc?.();
            pagedPeak = Math.max(pagedPeak, process.memoryUsage().heapUsed);
          }
        }
        if (message.kind === "hello") {
          helloLastSeq = message.lastSeq ?? null;
          abort.abort();
        }
      }
    }

    expect(eventCount).toBe(5_000);
    expect(ordered).toBe(true);
    expect(helloLastSeq).toBe(lastSeq.toString());
    const pagedHeapDelta = pagedPeak - pagedStart;
    console.info(`I10 heap delta: unpaged=${unpagedHeapDelta}B, paged=${pagedHeapDelta}B`);
    expect(pagedHeapDelta).toBeLessThan(unpagedHeapDelta * 0.5);
  });
});
