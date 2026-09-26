import { describe, it, expect } from "vitest";
import { buildSeatSettlement } from "./settlement";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

const doc = {
  flow: { voteMode: "culprit" },
  truth: { culpritId: "liu" },
  characters: [{ id: "liu", name: "柳承业" }, { id: "fu", name: "傅月娥" }],
  ending: {
    outcomes: [
      { result: "culprit_caught", title: "水落石出", content: [{ type: "paragraph", text: "凶手落网。" }] },
      { result: "culprit_escaped", title: "灯影遁去", content: [{ type: "paragraph", text: "凶手远走。" }] },
    ],
  },
} as unknown as ScriptDocV2;

const voteResult = { counts: { "0": 5, "1": 1 }, culpritSeat: 0, caught: true };
const publicIds = new Set(["a", "b", "c"]);

describe("座位结算投影", () => {
  it("凶手座位：被抓 → exposed 卡，带结局标题/判词/被指认票数，settlement 恒 null", () => {
    const view = buildSeatSettlement({ doc, mySeat: 0, myCharacterId: "liu", voteResult, publicEvidenceIds: publicIds, myVote: { target: 1, evidenceIds: ["a"] } });
    expect(view.settlement).toBeNull();
    expect(view.culpritSettlement).toEqual({ outcome: "exposed", title: "水落石出", verdict: "真凶「柳承业」被成功指认。", votesAgainst: 5 });
  });

  it("凶手座位：逃脱 → escaped 卡，verdict 说明逃脱", () => {
    const escaped = { counts: { "0": 2, "1": 2, "2": 2 }, culpritSeat: 0, caught: false, tiedSeats: [0, 1, 2] };
    const view = buildSeatSettlement({ doc, mySeat: 0, myCharacterId: "liu", voteResult: escaped, publicEvidenceIds: publicIds, myVote: null });
    expect(view.culpritSettlement).toMatchObject({ outcome: "escaped", title: "灯影遁去", votesAgainst: 2 });
    expect(view.culpritSettlement?.verdict).toContain("平票");
  });

  it("侦探座位投对且证据全合法：沿用 70+10/张 公式", () => {
    const view = buildSeatSettlement({ doc, mySeat: 1, myCharacterId: "fu", voteResult, publicEvidenceIds: publicIds, myVote: { target: 0, evidenceIds: ["a", "b", "c", "ghost"] } });
    expect(view.culpritSettlement).toBeNull();
    expect(view.settlement).toEqual({ outcome: "caught", voteCorrect: true, evidenceCount: 3, score: 100, myVoteTarget: 0 });
  });

  it("侦探座位投错：0 分底 + 证据分，voteCorrect=false", () => {
    const view = buildSeatSettlement({ doc, mySeat: 2, myCharacterId: "bai", voteResult, publicEvidenceIds: publicIds, myVote: { target: 1, evidenceIds: ["a"] } });
    expect(view.settlement).toEqual({ outcome: "caught", voteCorrect: false, evidenceCount: 1, score: 10, myVoteTarget: 1 });
  });

  it("凶手未入座（culpritSeat<0）：在场没有凶手角色，全员走侦探分支且 voteCorrect 恒 false", () => {
    const missing = { counts: { "0": 3 }, culpritSeat: -1, caught: false };
    const view = buildSeatSettlement({ doc, mySeat: 0, myCharacterId: "fu", voteResult: missing, publicEvidenceIds: publicIds, myVote: { target: 1 } });
    expect(view.culpritSettlement).toBeNull();
    expect(view.settlement).toMatchObject({ outcome: "escaped", voteCorrect: false });
  });

  it("choice 模式与观战者：两类结算均为 null", () => {
    const choice = { ...doc, flow: { voteMode: "choice" } } as unknown as ScriptDocV2;
    expect(buildSeatSettlement({ doc: choice, mySeat: 0, myCharacterId: "liu", voteResult, publicEvidenceIds: publicIds, myVote: null }).settlement).toBeNull();
    expect(buildSeatSettlement({ doc: choice, mySeat: 0, myCharacterId: "liu", voteResult, publicEvidenceIds: publicIds, myVote: null }).culpritSettlement).toBeNull();
    expect(buildSeatSettlement({ doc, mySeat: null, myCharacterId: null, voteResult, publicEvidenceIds: publicIds, myVote: null }).settlement).toBeNull();
    expect(buildSeatSettlement({ doc, mySeat: null, myCharacterId: null, voteResult, publicEvidenceIds: publicIds, myVote: null }).culpritSettlement).toBeNull();
  });
});
