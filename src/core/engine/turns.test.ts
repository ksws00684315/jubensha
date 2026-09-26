import { describe, expect, it } from "vitest";
import { readingPauseMs } from "./turns";

describe("阅读停顿", () => {
  it("短句和空话不打断节奏，正常发言按字数停留", () => {
    expect(readingPauseMs("")).toBe(0);
    expect(readingPauseMs("好。")).toBe(0);
    expect(readingPauseMs("这是一段足够让下一位等一等的发言，大家先看完。")).toBeGreaterThanOrEqual(3500);
    expect(readingPauseMs("字".repeat(400))).toBe(8000);
  });
});
