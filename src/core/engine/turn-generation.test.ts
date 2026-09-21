import { it, expect, vi } from "vitest";
import { dispatchTurn } from "./turns";
import type { GameEngine } from "./engine";
vi.mock("@/core/agents", () => ({ agent: {} }));
vi.mock("./bus", () => ({ publish: vi.fn() }));
it("看门狗结束后拒绝迟到 generation，不能覆盖下一回合", async () => {
  vi.useFakeTimers();
  let release!: (text: string) => void;
  const commit = vi.fn(); const abort = vi.fn();
  const e = { state: { phase: "DISCUSSION", round: 1, turnSeat: 0 }, turnToken: 0, turnInFlight: false, exclusive: async (fn: () => Promise<void>) => fn(), continueTick: vi.fn(), scheduleBackground: (_key: string, fn: () => void, ms: number) => setTimeout(fn, ms) } as unknown as GameEngine;
  dispatchTurn(e, { timeoutMs: 10, produce: () => new Promise((resolve) => { release = resolve; }), stale: () => false, commit, onAbort: abort });
  await vi.advanceTimersByTimeAsync(5030);
  expect(abort).toHaveBeenCalledTimes(1);
  e.turnInFlight = true; e.turnToken++;
  release("迟到回答"); await vi.advanceTimersByTimeAsync(1);
  expect(commit).not.toHaveBeenCalled(); expect(e.turnInFlight).toBe(true);
  vi.clearAllTimers(); vi.useRealTimers();
});
