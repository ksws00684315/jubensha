import { describe, expect, it, vi } from "vitest";
import { reportSpeechFailure } from "./speech-failure-notice";

describe("reportSpeechFailure", () => {
  it("同一阶段与轮次的同类错误只写一条公开提示", async () => {
    const engine = {
      state: { phase: "DISCUSSION" as const, round: 1 },
      speakerName: vi.fn((seat: number) => `玩家${seat + 1}`),
      systemSay: vi.fn(async () => {}),
    };

    await expect(reportSpeechFailure(engine, 0, "用途槽位尚未绑定模型")).resolves.toBe(true);
    await expect(reportSpeechFailure(engine, 1, "用途槽位尚未绑定模型")).resolves.toBe(false);

    expect(engine.systemSay).toHaveBeenCalledTimes(1);
    expect(engine.systemSay).toHaveBeenCalledWith(expect.stringContaining("玩家1"));
  });

  it("不同原因或不同轮次各保留一条提示", async () => {
    const engine = {
      state: { phase: "DISCUSSION" as const, round: 1 },
      speakerName: vi.fn(() => "玩家一"),
      systemSay: vi.fn(async () => {}),
    };

    await reportSpeechFailure(engine, 0, "错误 A");
    await reportSpeechFailure(engine, 1, "错误 B");
    engine.state.round++;
    await reportSpeechFailure(engine, 2, "错误 A");

    expect(engine.systemSay).toHaveBeenCalledTimes(3);
  });
});
