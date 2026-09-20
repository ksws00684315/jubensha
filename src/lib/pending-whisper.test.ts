import { describe, expect, it } from "vitest";
import { applyPendingWhisperResult, createPendingWhisper, editPendingWhisper, isPendingWhisperDue, retryPendingWhisper } from "./pending-whisper";

describe("私聊待发送窗口", () => {
  it("发送前等待三秒，编辑后重新计时", () => {
    const queued = createPendingWhisper("先前的草稿", 1000);
    expect(isPendingWhisperDue(queued, 3999)).toBe(false);
    const edited = editPendingWhisper(queued, "修正后的内容", 2500);
    expect(edited.dueAt).toBe(5500);
    expect(isPendingWhisperDue(edited, 5499)).toBe(false);
    expect(isPendingWhisperDue(edited, 5500)).toBe(true);
  });

  it("失败保留可编辑草稿，重试再次等待三秒", () => {
    const queued = createPendingWhisper("私聊内容", 0);
    const failed = applyPendingWhisperResult(queued, false);
    expect(failed).toMatchObject({ text: "私聊内容", failed: true });
    expect(isPendingWhisperDue(failed!, 10_000)).toBe(false);
    const retry = retryPendingWhisper(failed!, 10_000);
    expect(retry.dueAt).toBe(13_000);
    expect(isPendingWhisperDue(retry, 12_999)).toBe(false);
    expect(applyPendingWhisperResult(retry, true)).toBeNull();
  });
});
