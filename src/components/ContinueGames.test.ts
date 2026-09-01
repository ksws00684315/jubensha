import { describe, expect, it } from "vitest";
import { isContinuableSession } from "./ContinueGames";

describe("isContinuableSession", () => {
  it("大厅和进行中的房间可以继续", () => {
    expect(isContinuableSession("lobby", null)).toBe(true);
    expect(isContinuableSession("playing", "DISCUSSION")).toBe(true);
  });

  it("已结束或中止的对局不出现在主页", () => {
    expect(isContinuableSession("ended", "ENDED")).toBe(false);
    expect(isContinuableSession("playing", "ENDED")).toBe(false);
    expect(isContinuableSession("aborted", null)).toBe(false);
  });
});
