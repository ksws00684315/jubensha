import { describe, expect, it } from "vitest";
import { countdownRemaining, formatCountdown } from "./human-timeout";

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
