import { describe, expect, it } from "vitest";
import { summarizeEvalRun } from "./runner";

describe("盲读评测汇总", () => {
  it("区分通过、缺失证据和越权泄露", () => {
    const summary = summarizeEvalRun([
      { snapshotId: "a", scriptTitle: "x", seatIndex: 0, scene: "opening", score: { snapshotId: "a", passed: true, issues: [] } },
      { snapshotId: "b", scriptTitle: "x", seatIndex: 0, scene: "public_evidence", score: { snapshotId: "b", passed: false, issues: [{ kind: "missing_required", value: "线索" }] } },
      { snapshotId: "c", scriptTitle: "x", seatIndex: 0, scene: "conditional_before", score: { snapshotId: "c", passed: false, issues: [{ kind: "forbidden_leak", value: "秘密" }] }, error: "人工标记" },
    ]);
    expect(summary).toEqual({ total: 3, passed: 1, passRate: 1 / 3, missingRequired: 1, forbiddenLeaks: 1, errors: 1 });
  });
});
