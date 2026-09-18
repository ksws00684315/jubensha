import { describe, expect, it } from "vitest";
import { buildFixedEvaluationBundle } from "./snapshots";
import { scoreEvalResponse } from "./scorer";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

const script = {
  version: 2,
  meta: { title: "评估样本", minPlayers: 3, maxPlayers: 3, durationMin: 60, difficulty: "新手", tags: [], intro: "样本" },
  background: [{ type: "paragraph", text: "夜里发生了一起案件。" }],
  characters: [
    { id: "jia", name: "甲", publicProfile: { bio: [{ type: "paragraph", text: "医生" }], relationships: [] }, privateCard: { backstory: [{ type: "paragraph", text: "背景" }], secrets: [{ id: "jia_secret", title: "甲的秘密", content: [{ type: "paragraph", text: "甲曾经改过病历" }], disclosure: "never" }], objectives: [{ id: "jia_goal", title: "目标", content: [{ type: "paragraph", text: "查清事实" }] }], timeline: [{ id: "jia_time", time: { display: "九点", start: { time: "21:00" } }, title: "在大厅", content: [{ type: "paragraph", text: "在大厅" }] }], knowledge: [], relationships: [], persona: { traits: [], speechStyle: "简洁", habits: [], taboos: [] }, isCulprit: false, alibi: [], violation: [], tells: [], stages: [], skills: [] } },
    { id: "yi", name: "乙", publicProfile: { bio: [{ type: "paragraph", text: "律师" }], relationships: [] }, privateCard: { backstory: [{ type: "paragraph", text: "背景" }], secrets: [{ id: "yi_secret", title: "乙的条件秘密", content: [{ type: "paragraph", text: "乙拿走过钥匙" }], disclosure: "conditional", condition: "第二轮后", trigger: { round: 2, publicClueIds: [] } }], objectives: [{ id: "yi_goal", title: "目标", content: [{ type: "paragraph", text: "自证" }] }], timeline: [{ id: "yi_time", time: { display: "九点", start: { time: "21:00" } }, title: "在走廊", content: [{ type: "paragraph", text: "在走廊" }] }], knowledge: [], relationships: [], persona: { traits: [], speechStyle: "谨慎", habits: [], taboos: [] }, isCulprit: true, alibi: [], violation: [], tells: [], stages: [], skills: [] } },
    { id: "bing", name: "丙", publicProfile: { bio: [{ type: "paragraph", text: "记者" }], relationships: [] }, privateCard: { backstory: [{ type: "paragraph", text: "背景" }], secrets: [{ id: "bing_secret", title: "丙的秘密", content: [{ type: "paragraph", text: "丙欠债" }], disclosure: "never" }], objectives: [{ id: "bing_goal", title: "目标", content: [{ type: "paragraph", text: "找出真凶" }] }], timeline: [{ id: "bing_time", time: { display: "九点", start: { time: "21:00" } }, title: "在花园", content: [{ type: "paragraph", text: "在花园" }] }], knowledge: [], relationships: [], persona: { traits: [], speechStyle: "直接", habits: [], taboos: [] }, isCulprit: false, alibi: [], violation: [], tells: [], stages: [], skills: [] } },
  ],
  locations: [{ id: "hall", name: "大厅", description: [] }, { id: "study", name: "书房", description: [] }],
  clues: [{ id: "blood", locationId: "study", name: "血迹报告", category: "medical", content: [{ type: "paragraph", text: "血迹时间为九点。" }], policy: "auto_public", relatedCharacterIds: [], relatedTruthEventIds: [], forbiddenCharacterIds: [] }, { id: "key", locationId: "hall", name: "旧钥匙", category: "object", content: [{ type: "paragraph", text: "钥匙边缘有新鲜划痕。" }], policy: "manual_public", relatedCharacterIds: [], relatedTruthEventIds: [], forbiddenCharacterIds: [] }, { id: "note", locationId: "hall", name: "便笺", category: "document", content: [{ type: "paragraph", text: "便笺写着稍后见。" }], policy: "manual_public", relatedCharacterIds: [], relatedTruthEventIds: [], forbiddenCharacterIds: [] }],
  truth: { culpritId: "yi", motive: [], method: { summary: [{ type: "paragraph", text: "下毒" }], steps: [{ id: "s", title: "下毒", content: [{ type: "paragraph", text: "下毒" }], clueIds: [] }] }, timeline: [{ id: "t", time: { display: "九点", start: { time: "21:00" } }, title: "案件", content: [{ type: "paragraph", text: "案件" }], participantIds: [] }], keyEvidenceIds: ["blood"], evidenceChain: [], redHerrings: [], supplemental: [], reveal: [{ type: "paragraph", text: "乙是凶手。" }] },
  flow: { selfIntroRounds: 1, searchRounds: 2, discussionRounds: 2, allowPrivateChat: true, privateChatMessageLimit: 3, allowClueTransfer: true, actionPointsPerRound: 0, voteMode: "culprit", acts: [] },
  ending: { outcomes: [{ result: "culprit_caught", title: "抓获", content: [{ type: "paragraph", text: "抓获" }] }, { result: "culprit_escaped", title: "逃脱", content: [{ type: "paragraph", text: "逃脱" }] }], quiz: [] },
} as unknown as ScriptDocV2;

describe("固定评估快照", () => {
  it("生成八个场景，快照不携带评分答案", () => {
    const { bundle, scoringKeys } = buildFixedEvaluationBundle(script);
    expect(bundle.snapshots.map((item) => item.scene)).toEqual([
      "opening", "public_evidence", "timeline_conflict", "conditional_before", "conditional_after", "forced_question", "after_transfer", "pre_vote",
    ]);
    expect(bundle.snapshots.every((item) => !("mustNotContain" in item))).toBe(true);
    expect(scoringKeys).toHaveLength(bundle.snapshots.length);
    expect(bundle.snapshots.find((item) => item.scene === "conditional_after")?.round).toBe(2);
  });

  it("评分器区分公开证据缺失与秘密泄露", () => {
    const { scoringKeys } = buildFixedEvaluationBundle(script);
    const key = scoringKeys.find((item) => item.snapshotId.startsWith("public_evidence-"))!;
    expect(scoreEvalResponse(key, "血迹报告显示了现场情况，血迹时间为九点。甲的秘密也被我说出来了")).toEqual({
      snapshotId: key.snapshotId,
      passed: false,
      issues: [{ kind: "forbidden_leak", value: "甲的秘密" }],
    });
    expect(scoreEvalResponse(key, "我只说大家已经看到的内容").issues.some((item) => item.kind === "missing_required")).toBe(true);
    expect(scoreEvalResponse(key, "我怀疑乙，但这只是根据现场证据的判断").issues.some((item) => item.kind === "forbidden_leak")).toBe(false);
  });
});
