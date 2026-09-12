import { describe, expect, it } from "vitest";
import { countdownRemaining, formatCountdown, needsHumanDeadline } from "./human-timeout";

describe("countdownRemaining", () => {
  it("无截止时间不显示倒计时", () => {
    expect(countdownRemaining(null, Date.now())).toBeNull();
    expect(countdownRemaining(undefined, Date.now())).toBeNull();
  });

  it("剩余超过 60 秒时不显示（只在最后 1 分钟出现）", () => {
    const now = Date.now();
    expect(countdownRemaining(now + 61_000, now)).toBeNull();
  });

  it("剩余 60 秒内显示剩余毫秒", () => {
    const now = Date.now();
    expect(countdownRemaining(now + 60_000, now)).toBe(60_000);
    expect(countdownRemaining(now + 42_500, now)).toBe(42_500);
    expect(countdownRemaining(now + 1, now)).toBe(1);
  });

  it("已到期或过期不显示（交给超时事件接管）", () => {
    const now = Date.now();
    expect(countdownRemaining(now, now)).toBeNull();
    expect(countdownRemaining(now - 1, now)).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("向上取整为秒，窗口起点显示 60", () => {
    expect(formatCountdown(60_000)).toBe("60 秒");
    expect(formatCountdown(59_999)).toBe("60 秒");
    expect(formatCountdown(42_500)).toBe("43 秒");
    expect(formatCountdown(1)).toBe("1 秒");
  });
});

describe("needsHumanDeadline", () => {
  // 回归 S3：提问会 clearHumanTimeout(提问者)，但提问者的回合没变。
  // 判据必须是"截止时间是否存在"，否则回到该回合时永远不会重新武装，流程卡死在 DISCUSSION。
  it("提交提问清掉截止时间后，回到该座位应判定为需要重新武装", () => {
    const deadlines: Record<string, number> = { "0": Date.now() + 100_000, "1": Date.now() + 100_000 };
    expect(needsHumanDeadline(deadlines, 0)).toBe(false);
    delete deadlines["0"]; // == clearHumanTimeout(0)
    expect(needsHumanDeadline(deadlines, 0)).toBe(true);
    expect(needsHumanDeadline(deadlines, 1)).toBe(false);
  });

  it("旧快照没有 humanDeadlines 时视为需要武装", () => {
    expect(needsHumanDeadline(undefined, 2)).toBe(true);
    expect(needsHumanDeadline({}, 2)).toBe(true);
  });
});
