import { describe, expect, it } from "vitest";
import { ensureDiscussionState, QUESTIONS_PER_PLAYER, nextAfterDiscussion, nextAfterSearch, validateDiscussionAsk } from "./flow";
import { initialState } from "./state";

describe("阶段轮次推进", () => {
  it("搜证轮数多于讨论轮数时，讨论结束后仍进入剩余搜证", () => {
    expect(nextAfterDiscussion(2, 3, 2)).toBe("SEARCH");
    expect(nextAfterSearch(3, 3, 2)).toBe("VOTE");
  });

  it("讨论轮数多于搜证轮数时，搜证结束后继续讨论", () => {
    expect(nextAfterDiscussion(2, 2, 3)).toBe("DISCUSSION");
    expect(nextAfterSearch(2, 2, 3)).toBe("DISCUSSION");
  });

  it("讨论提问次数每人 3 次，且不覆盖已有余额", () => {
    const state = initialState([
      { index: 0, kind: "human", characterId: "a", playerName: "A" },
      { index: 1, kind: "ai", characterId: "b", playerName: "B" },
    ]);
    ensureDiscussionState(state);
    expect(state.questionsLeft["0"]).toBe(QUESTIONS_PER_PLAYER);
    expect(state.questionsLeft["1"]).toBe(QUESTIONS_PER_PLAYER);
    state.questionsLeft["0"] = 1;
    ensureDiscussionState(state);
    expect(state.questionsLeft["0"]).toBe(1);
  });

  it("讨论提问必须轮到自己、对方空闲、次数未用尽", () => {
    const state = initialState([
      { index: 0, kind: "human", characterId: "a", playerName: "A" },
      { index: 1, kind: "ai", characterId: "b", playerName: "B" },
    ]);
    expect(validateDiscussionAsk(state, 0, 1)).toBe("当前不在讨论环节");
    state.phase = "DISCUSSION";
    state.turnSeat = 0;
    ensureDiscussionState(state);
    expect(validateDiscussionAsk(state, 0, 1)).toBeNull();
    expect(validateDiscussionAsk(state, 1, 0)).toBe("还没轮到你提问");
    expect(validateDiscussionAsk(state, 0, 0)).toBe("不能向自己提问");
    state.questionsLeft["0"] = 0;
    expect(validateDiscussionAsk(state, 0, 1)).toBe("提问次数已用完");
    state.questionsLeft["0"] = 2;
    state.pendingAnswer = { fromSeat: 0, toSeat: 1, question: "你当时在哪？" };
    expect(validateDiscussionAsk(state, 0, 1)).toBe("请先等待当前提问被回答");
  });
});
