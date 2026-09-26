import { describe, it, expect } from "vitest";
import { illegalPublicEvidenceIds, legalPublicEvidenceIds, validateVoteEvidence } from "./evidence";

const clues = [{ id: "a" }, { id: "b" }, { id: "c" }] as const;
const allPublic = { a: { discoveredBy: 0, isPublic: true }, b: { discoveredBy: 1, isPublic: true } };

describe("投票证据校验", () => {
  it("场上存在公开证据但不附 evidenceIds：报错指明字段", () => {
    expect(validateVoteEvidence(clues, allPublic, undefined)).toBe("投票需引用公开证据：请在 evidenceIds 中附至少一张公开线索卡");
    expect(validateVoteEvidence(clues, allPublic, [])).toBe("投票需引用公开证据：请在 evidenceIds 中附至少一张公开线索卡");
  });

  it("全部 id 非法：逐个列出", () => {
    expect(validateVoteEvidence(clues, allPublic, ["hidden", "ghost"])).toBe("证据含非法或未公开的线索卡：hidden、ghost");
  });

  it("混合合法与非法：整体拒绝并列出非法项", () => {
    expect(validateVoteEvidence(clues, allPublic, ["a", "hidden"])).toBe("证据含非法或未公开的线索卡：hidden");
  });

  it("全部合法：放行", () => {
    expect(validateVoteEvidence(clues, allPublic, ["b", "a", "a"])).toBeNull();
  });

  it("场上没有公开证据时不附 id：放行（沿用历史行为）", () => {
    expect(validateVoteEvidence(clues, {}, undefined)).toBeNull();
    expect(validateVoteEvidence(clues, {}, [])).toBeNull();
    // 但附了非法 id 依然拒绝
    expect(validateVoteEvidence(clues, {}, ["hidden"])).toBe("证据含非法或未公开的线索卡：hidden");
  });
});

describe("公开证据过滤", () => {
  it("legalPublicEvidenceIds 去重并过滤未公开项", () => {
    const e = { script: { clues }, state: { clueStates: allPublic } };
    expect(legalPublicEvidenceIds(e as never, ["a", "a", "b", "hidden", "c"])).toEqual(["a", "b"]);
    expect(legalPublicEvidenceIds(e as never, undefined)).toEqual([]);
  });

  it("illegalPublicEvidenceIds 只留非法项", () => {
    expect(illegalPublicEvidenceIds(clues, allPublic, ["a", "hidden", "ghost"])).toEqual(["hidden", "ghost"]);
  });
});
