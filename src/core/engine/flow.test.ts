import { describe, expect, it } from "vitest";
import { nextAfterDiscussion, nextAfterSearch } from "./flow";

describe("阶段轮次推进", () => {
  it("搜证轮数多于讨论轮数时，讨论结束后仍进入剩余搜证", () => {
    expect(nextAfterDiscussion(2, 3, 2)).toBe("SEARCH");
    expect(nextAfterSearch(3, 3, 2)).toBe("VOTE");
  });

  it("讨论轮数多于搜证轮数时，搜证结束后继续讨论", () => {
    expect(nextAfterDiscussion(2, 2, 3)).toBe("DISCUSSION");
    expect(nextAfterSearch(2, 2, 3)).toBe("DISCUSSION");
  });
});
