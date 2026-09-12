/* eslint-disable @typescript-eslint/no-explicit-any -- 测试助手需要以 any 就地改动种子 JSON */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDocV2, publicScriptViewV2 } from "./schema";
import { validateScriptV2 } from "./validate";
import { buildDmContext, buildPlayerContext } from "@/core/agents/context";
import { unlockedActs } from "@/core/engine/flow";
import { clueReachable } from "@/core/engine/state";
import { initialState } from "@/core/engine/state";
import type { GameState } from "@/core/engine/types";

const raw = JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8"));
const doc = parseScriptDocV2(raw);

function cloneWith(mutate: (d: any) => void) {
  const copy = JSON.parse(JSON.stringify(raw));
  mutate(copy);
  return parseScriptDocV2(copy);
}

function stateOf(phase: GameState["phase"], round: number): GameState {
  const order = ["suwan", "zhoubo", "qinghe", "baimusen", "luxiaokai"];
  const state = initialState(order.map((characterId, i) => ({ index: i, kind: "ai" as const, characterId, playerName: `P${i}` })));
  state.phase = phase;
  state.round = round;
  return state;
}

describe("Schema v2.x 新字段（向后兼容）", () => {
  it("旧剧本（无新字段）仍可解析", () => {
    expect(doc.version).toBe(2);
    expect(doc.flow.acts).toEqual([]);
    expect(doc.characters.every((c) => c.privateCard.violation.length === 0)).toBe(true);
    expect(doc.clues.every((c) => c.forbiddenCharacterIds.length === 0)).toBe(true);
  });

  it("must_share 秘密 / knowledge kind / alibi / violation / tells / release / 禁搜 / owner / acts+stages / hostGuide 均可解析", () => {
    const d2 = cloneWith((d) => {
      d.characters[1].privateCard.secrets[0].disclosure = "must_share";
      d.characters[1].privateCard.knowledge[0].kind = "claim";
      d.characters[1].privateCard.alibi = [{ type: "paragraph", text: "21:15 我在送茶。" }];
      d.characters[1].privateCard.violation = ["绝不承认动过账本"];
      d.characters[1].privateCard.tells = ["说谎时摸耳垂"];
      d.characters[1].privateCard.stages = [
        { actId: "act_2", knowledge: [{ id: "k_new", title: "新知", content: [{ type: "paragraph", text: "第二幕才知道的事" }], kind: "fact", source: "heard", relatedCharacterIds: [], relatedClueIds: [] }], objectives: [] },
      ];
      d.clues[0].forbiddenCharacterIds = ["suwan"];
      d.clues[1].release = { round: 2, afterCluePublicIds: [] };
      d.locations[0].ownerCharacterId = "suwan";
      d.flow.acts = [{ id: "act_2", title: "第二幕", brief: [{ type: "paragraph", text: "夜更深了。" }], roundStart: 2 }];
      d.hostGuide = {
        perPhase: [{ phase: "DISCUSSION", notes: "引导大家比对时间线" }],
        stallBreakers: [{ condition: "两轮无人提出矛盾", hint: "由 AI 主动质疑时间线" }],
      };
    });
    expect(d2.characters[1].privateCard.secrets[0].disclosure).toBe("must_share");
    expect(d2.flow.acts[0].title).toBe("第二幕");
    expect(d2.hostGuide?.perPhase[0].notes).toContain("时间线");
    expect(validateScriptV2(d2).filter((i) => i.level === "error")).toHaveLength(0);
  });
});

describe("Validator 新规则", () => {
  it("R1 线索数超过 可搜上限(人数×轮数) → error", () => {
    const d2 = cloneWith((d) => {
      d.clues.push({ ...d.clues[0], id: "extra_clue", name: "多出来的一条" });
    });
    const errors = validateScriptV2(d2).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("超过可发现上限"))).toBe(true);
  });

  it("R2 证据链单线索支撑 → warning；S1 残留真凶姓名 → warning", () => {
    const d2 = cloneWith((d) => {
      d.truth.evidenceChain = [{ id: "c1", clueIds: ["bottle"], conclusion: "毒源即凶器来源。" }];
      d.characters[1].privateCard.knowledge[0].content = [{ type: "paragraph", text: "你亲眼看见苏晚在书房出入。" }];
    });
    const issues = validateScriptV2(d2);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("单线索锁凶"))).toBe(true);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("真凶姓名"))).toBe(true);
  });

  it("stages 指向不存在的幕 → error", () => {
    const d2 = cloneWith((d) => {
      d.characters[1].privateCard.stages = [{ actId: "no_such_act", knowledge: [], objectives: [] }];
    });
    expect(validateScriptV2(d2).some((i) => i.level === "error" && i.message.includes("幕不存在"))).toBe(true);
  });
});

describe("引擎纯函数", () => {
  it("unlockedActs：讨论/搜证阶段按轮解锁，读本阶段不解锁", () => {
    const acts = [
      { id: "a1", title: "一", brief: [], roundStart: 1 },
      { id: "a2", title: "二", brief: [], roundStart: 2 },
    ];
    expect(unlockedActs(acts, { phase: "READING", round: 0 })).toHaveLength(0);
    expect(unlockedActs(acts, { phase: "SEARCH", round: 1 }).map((a) => a.id)).toEqual(["a1"]);
    expect(unlockedActs(acts, { phase: "DISCUSSION", round: 2 }).map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("clueReachable：禁搜/轮次/前置公开线索", () => {
    const clue = { forbiddenCharacterIds: ["suwan"], release: { round: 2, afterCluePublicIds: ["bottle"] } };
    expect(clueReachable(clue, { seatCharacterId: "suwan", round: 3, publicClueIds: ["bottle"] })).toBe(false);
    expect(clueReachable(clue, { seatCharacterId: "zhoubo", round: 1, publicClueIds: ["bottle"] })).toBe(false);
    expect(clueReachable(clue, { seatCharacterId: "zhoubo", round: 2, publicClueIds: [] })).toBe(false);
    expect(clueReachable(clue, { seatCharacterId: "zhoubo", round: 2, publicClueIds: ["bottle"] })).toBe(true);
  });
});

describe("上下文消费", () => {
  it("must_share 秘密、knowledge kind 前缀、alibi/violation/tells 渲染进 system", () => {
    const d2 = cloneWith((d) => {
      d.characters[1].privateCard.secrets[0].disclosure = "must_share";
      d.characters[1].privateCard.knowledge[0].kind = "claim";
      d.characters[1].privateCard.alibi = [{ type: "paragraph", text: "21:15 我在送茶。" }];
      d.characters[1].privateCard.violation = ["绝不承认动过账本"];
      d.characters[1].privateCard.tells = ["说谎时摸耳垂"];
    });
    const state = stateOf("DISCUSSION", 1);
    const joined = buildPlayerContext(d2, state, 1, [], {}).map((m) => m.content).join("\n");
    expect(joined).toContain("必须找机会说出去");
    expect(joined).toContain("【传闻】");
    expect(joined).toContain("21:15 我在送茶。");
    expect(joined).toContain("绝不承认动过账本");
    expect(joined).toContain("说谎时摸耳垂");
  });

  it("已解锁幕的 stages 注入【本幕新知】；未解锁轮次不注入", () => {
    const d2 = cloneWith((d) => {
      d.flow.acts = [{ id: "act_2", title: "第二幕", brief: [{ type: "paragraph", text: "夜更深了。" }], roundStart: 2 }];
      d.characters[1].privateCard.stages = [
        { actId: "act_2", knowledge: [{ id: "k_new", title: "新知", content: [{ type: "paragraph", text: "第二幕才知道的事" }], kind: "fact", source: "heard", relatedCharacterIds: [], relatedClueIds: [] }], objectives: [] },
      ];
    });
    const later = buildPlayerContext(d2, stateOf("DISCUSSION", 2), 1, [], {}).map((m) => m.content).join("\n");
    expect(later).toContain("【本幕新知】");
    expect(later).toContain("第二幕才知道的事");
    const earlier = buildPlayerContext(d2, stateOf("DISCUSSION", 1), 1, [], {}).map((m) => m.content).join("\n");
    expect(earlier).not.toContain("【本幕新知】");
    expect(earlier).not.toContain("第二幕才知道的事");
  });

  it("公开切片不暴露 hostGuide/私卡", () => {
    const view = publicScriptViewV2(doc) as unknown as Record<string, unknown>;
    expect("hostGuide" in view).toBe(false);
    expect("truth" in view).toBe(false);
  });

  it("S1 扫描面覆盖 secret/backstory/objectives（不只 knowledge）", () => {
    const d2 = cloneWith((d: any) => {
      const culpritName = d.characters.find((c: any) => c.id === d.truth.culpritId).name;
      const innocent = d.characters.find((c: any) => c.id !== d.truth.culpritId);
      innocent.privateCard.secrets[0].content = [{ type: "paragraph", text: `你亲眼看见${culpritName}行凶。` }];
      innocent.privateCard.backstory = [{ type: "paragraph", text: `你的旧怨源于${culpritName}。` }];
      innocent.privateCard.objectives[0].content = [{ type: "paragraph", text: `让别人的嘴说出${culpritName}三个字。` }];
    });
    const issues = validateScriptV2(d2).filter((i) => i.level === "warning" && i.message.includes("真凶姓名"));
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it("VOTE 阶段全部幕视为已解锁（分幕增量不消失）", () => {
    const acts: Array<{ id: string; title: string; brief: never[]; roundStart: number }> = [
      { id: "a1", title: "一", brief: [], roundStart: 1 },
      { id: "a2", title: "二", brief: [], roundStart: 2 },
    ];
    expect(unlockedActs(acts, { phase: "VOTE", round: 1 })).toHaveLength(2);
  });

  it("hostGuide 只进 DM 上下文，绝不进玩家上下文（防火墙）", () => {
    const d2 = cloneWith((d) => {
      d.hostGuide = {
        perPhase: [{ phase: "DISCUSSION", notes: "手册密语：引导众人比对茶的温度" }],
        stallBreakers: [{ condition: "无人发言", hint: "手册密语：由 AI 抛出手记疑点" }],
      };
    });
    const state = stateOf("DISCUSSION", 1);
    const dmJoined = buildDmContext(d2, state, [], { task: "控场" }).map((m) => m.content).join("\n");
    expect(dmJoined).toContain("手册密语");
    for (let seat = 0; seat < d2.characters.length; seat++) {
      const playerJoined = buildPlayerContext(d2, state, seat, [], {}).map((m) => m.content).join("\n");
      expect(playerJoined).not.toContain("手册密语");
    }
  });
});
