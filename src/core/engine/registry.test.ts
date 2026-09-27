import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn() } }));

let engines: Map<string, { state: { phase: string; round: number; humanDeadlines?: Record<string, number> }; events: Array<{ createdAt: string }>; turnInFlight: boolean }>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
  vi.resetModules();
  warn.mockClear();
  ({ engines } = await import("./registry"));
  engines.clear();
  (globalThis as unknown as { __jbsStuckWarnings: Map<string, number> }).__jbsStuckWarnings.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  (globalThis as unknown as { __jbsStuckWatchTimer?: NodeJS.Timeout }).__jbsStuckWatchTimer = undefined;
  vi.useRealTimers();
});

function addEngine(id: string, options: { idleMs?: number; phase?: string; turnInFlight?: boolean; humanDeadline?: number } = {}): void {
  const now = Date.now();
  engines.set(id, {
    state: {
      phase: options.phase ?? "DISCUSSION",
      round: 2,
      humanDeadlines: options.humanDeadline === undefined ? {} : { "0": options.humanDeadline },
    },
    events: [{ createdAt: new Date(now - (options.idleMs ?? 300_001)).toISOString() }],
    turnInFlight: options.turnInFlight ?? false,
  });
}

describe("engine stuck watch", () => {
  it("对局超过 5 分钟无事件且没有执行中回合或真人截止时间时告警", async () => {
    addEngine("stuck-game");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledWith("engine.stuck", {
      gameId: "stuck-game",
      phase: "DISCUSSION",
      round: 2,
      idleSec: 360,
    });
  });

  it("活跃真人截止时间、执行中回合与终局都不会告警", async () => {
    const now = Date.now();
    addEngine("human-wait", { humanDeadline: now + 120_000 });
    addEngine("turn-in-flight", { turnInFlight: true });
    addEngine("ended-game", { phase: "ENDED" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).not.toHaveBeenCalled();

    const humanWait = engines.get("human-wait");
    if (humanWait) delete humanWait.state.humanDeadlines?.["0"];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("engine.stuck", expect.objectContaining({ gameId: "human-wait" }));
  });

  it("每局告警后 15 分钟内节流，之后可再次提醒", async () => {
    addEngine("throttled-game");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
