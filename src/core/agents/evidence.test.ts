import { describe, expect, it } from "vitest";
import { buildPublicEvidenceRegistry, renderPublicEvidenceRegistry } from "./evidence";
import { initialState } from "@/core/engine/state";
import type { EngineEvent } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

const script = {
  version: 2,
  meta: { title: "证据样本", minPlayers: 3, maxPlayers: 3, durationMin: 60, difficulty: "新手", tags: [], intro: "样本" },
  background: [{ type: "paragraph", text: "案件" }],
  characters: [
    ...["a", "b", "c"].map((id, i) => ({ id, name: `角色${i}`, publicProfile: { bio: [{ type: "paragraph", text: "身份" }], relationships: [] }, privateCard: { backstory: [{ type: "paragraph", text: "背景" }], secrets: [{ id: `${id}_secret`, title: `${id}秘密`, content: [{ type: "paragraph", text: "私密" }], disclosure: "never" }], objectives: [{ id: `${id}_goal`, title: "目标", content: [{ type: "paragraph", text: "目标" }] }], timeline: [{ id: `${id}_time`, time: { display: "九点", start: { time: "21:00" } }, title: "事件", content: [{ type: "paragraph", text: "事件" }] }], knowledge: [], relationships: [], persona: { traits: [], speechStyle: "平静", habits: [], taboos: [] }, isCulprit: i === 0, alibi: [], violation: [], tells: [], stages: [], skills: [] } })),
  ],
  locations: [{ id: "room", name: "房间", description: [] }, { id: "yard", name: "院子", description: [] }],
  clues: [{ id: "c1", locationId: "room", name: "关键账本", category: "document", content: [{ type: "paragraph", text: "账本记录了完整的九点交易时间。" }], policy: "manual_public", relatedCharacterIds: [], relatedTruthEventIds: [], forbiddenCharacterIds: [] }, { id: "c2", locationId: "yard", name: "脚印", category: "trace", content: [{ type: "paragraph", text: "脚印朝向院门。" }], policy: "manual_public", relatedCharacterIds: [], relatedTruthEventIds: [], forbiddenCharacterIds: [] }, { id: "c3", locationId: "yard", name: "照片", category: "object", content: [{ type: "paragraph", text: "照片上有三个人。" }], policy: "manual_public", relatedCharacterIds: [], relatedTruthEventIds: [], forbiddenCharacterIds: [] }],
  truth: { culpritId: "a", motive: [], method: { summary: [{ type: "paragraph", text: "方法" }], steps: [{ id: "m", title: "方法", content: [{ type: "paragraph", text: "方法" }], clueIds: [] }] }, timeline: [{ id: "t", time: { display: "九点", start: { time: "21:00" } }, title: "案件", content: [{ type: "paragraph", text: "案件" }], participantIds: [] }], keyEvidenceIds: [], evidenceChain: [], redHerrings: [], supplemental: [], reveal: [{ type: "paragraph", text: "复盘" }] },
  flow: { selfIntroRounds: 1, searchRounds: 2, discussionRounds: 2, allowPrivateChat: false, privateChatMessageLimit: 3, allowClueTransfer: false, actionPointsPerRound: 0, voteMode: "culprit", acts: [] },
  ending: { outcomes: [{ result: "culprit_caught", title: "抓获", content: [{ type: "paragraph", text: "抓获" }] }, { result: "culprit_escaped", title: "逃脱", content: [{ type: "paragraph", text: "逃脱" }] }], quiz: [] },
} as unknown as ScriptDocV2;

describe("公开证据登记", () => {
  it("保留公开线索完整原文、来源序号，并将玩家说法标成 claim", () => {
    const state = initialState(script.characters.map((c, index) => ({ index, kind: "ai", characterId: c.id, playerName: c.name })));
    state.clueStates.c1 = { discoveredBy: 1, isPublic: true };
    const events: EngineEvent[] = [
      { seq: "7", type: "clue", phase: "SEARCH", round: 1, fromSeat: 1, toSeat: null, visibility: "public", content: { clueId: "c1", clueName: "关键账本", clueContent: "账本记录了完整的九点交易时间。" }, createdAt: "" },
      { seq: "8", type: "speech", phase: "DISCUSSION", round: 1, fromSeat: 2, toSeat: null, visibility: "public", content: { text: "我说九点在院子", speakerName: "角色2" }, createdAt: "" },
    ];
    const records = buildPublicEvidenceRegistry(script, state, events);
    expect(records[0]).toMatchObject({ id: "clue:c1", kind: "clue", text: "账本记录了完整的九点交易时间。", sourceSeqs: ["7"] });
    expect(records[1]).toMatchObject({ id: "claim:8", kind: "claim", speakerSeat: 2, sourceSeqs: ["8"] });
    expect(renderPublicEvidenceRegistry(records)).toContain("完整的九点交易时间");
    expect(renderPublicEvidenceRegistry(records)).not.toContain("我说九点在院子");
    expect(renderPublicEvidenceRegistry(records, { includeClaims: true })).toContain("待核实主张");
  });
});
