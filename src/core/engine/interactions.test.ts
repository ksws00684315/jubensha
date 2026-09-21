import { describe, it, expect, vi, afterEach } from "vitest";
import { runInteractionBeats, chooseInteraction } from "./interactions";
import { initialState } from "./state";
import type { GameEngine } from "./engine";
vi.mock("@/core/agents", () => ({ agent: { playerInteraction: vi.fn(async () => "yes") } }));
vi.mock("@/lib/db", () => ({ db: {} }));
function fixture(kind: "human" | "ai" | "empty" = "human") {
  const state = initialState([{ index: 0, characterId: "c", kind, playerName: "角色" }]);
  state.phase = "DISCUSSION"; state.round = 1; state.turnSeat = null;
  const e = { state, script: { flow: { interactionBeats: [{ id: "b", round: 1, timing: "after_discussion", characterId: "c", prompt: "选择", choices: [{ id: "yes", label: "接受", recap: "选择接受" }, { id: "no", label: "沉默", recap: "保持沉默" }], defaultChoiceId: "no", visibility: "public" }] } },
    timers: new Map(), turnAsked: new Set(), events: [] as unknown[], speakerName: () => "角色", persist: vi.fn(), systemSay: vi.fn(), continueTick: vi.fn(), clearTimers: vi.fn(),
    recordEvent: vi.fn(async (ev) => { e.events.push(ev); }), exclusive: async (fn: () => Promise<void>) => fn(),
    ctx: vi.fn(), schedule: (key: string, fn: () => void, ms: number) => { e.timers.set(key, setTimeout(fn, ms)); }, scheduleBackground: (_key: string, fn: () => void, ms: number) => setTimeout(fn, ms) };
  return e as unknown as GameEngine;
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("讨论后互动", () => {
  it("真人选择只提交一次，非法座位和选项拒绝", async () => {
    vi.useFakeTimers(); const e = fixture();
    expect(await runInteractionBeats(e)).toBe(true);
    expect((await chooseInteraction(e, 1, "b", "yes")).ok).toBe(false);
    expect((await chooseInteraction(e, 0, "b", "bad")).ok).toBe(false);
    expect((await chooseInteraction(e, 0, "b", "yes")).ok).toBe(true);
    expect((await chooseInteraction(e, 0, "b", "yes")).ok).toBe(false);
    expect(e.state.interactionChoices?.b.choiceId).toBe("yes");
    expect(await runInteractionBeats(e)).toBe(false);
    expect(e.events).toHaveLength(1);
  });
  it("重启后仍按原截止时间默认选择", async () => {
    vi.useFakeTimers(); const e = fixture(); await runInteractionBeats(e);
    const saved = JSON.parse(JSON.stringify(e.state));
    vi.clearAllTimers(); const restored = fixture(); restored.state = saved;
    await runInteractionBeats(restored);
    await vi.advanceTimersByTimeAsync(180001);
    expect(restored.state.interactionChoices?.b.choiceId).toBe("no");
  });
  it("AI 按结构化选项选择", async () => {
    vi.useFakeTimers(); const e = fixture("ai"); await runInteractionBeats(e); await vi.advanceTimersByTimeAsync(60);
    expect(e.state.interactionChoices?.b.choiceId).toBe("yes");
  });
  it("缺席角色记录跳过", async () => {
    const e = fixture("empty"); expect(await runInteractionBeats(e)).toBe(false);
    expect(e.state.interactionChoices?.b.skipped).toBe(true);
  });
});
