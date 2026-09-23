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
// 用去掉可选分幕字段的副本验证旧文档兼容性；样板种子本身已开始配置分幕。
const legacyRaw = JSON.parse(JSON.stringify(raw));
delete legacyRaw.flow.acts;
const doc = parseScriptDocV2(legacyRaw);

function cloneWith(mutate: (d: any) => void) {
  const copy = JSON.parse(JSON.stringify(raw));
  // 样板种子现在带有 act/stages；大多数兼容性测试需要从“旧文档”起步，避免
  // 未参与该测试的样板幕干扰自定义引用校验。
  delete copy.flow.acts;
  for (const character of copy.characters) delete character.privateCard.stages;
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
    expect(doc.flow.allowClueTransfer).toBe(false);
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
        guaranteedPublicClues: [{ clueId: "bottle", deadlineRound: 2 }],
      };
    });
    expect(d2.characters[1].privateCard.secrets[0].disclosure).toBe("must_share");
    expect(d2.flow.acts[0].title).toBe("第二幕");
    expect(d2.hostGuide?.perPhase[0].notes).toContain("时间线");
    expect(d2.hostGuide?.guaranteedPublicClues[0]).toEqual({ clueId: "bottle", deadlineRound: 2 });
    expect(validateScriptV2(d2).filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("主持保证公开不能引用不存在或 keep_private 的线索", () => {
    const missing = cloneWith((d) => {
      d.hostGuide = { guaranteedPublicClues: [{ clueId: "missing", deadlineRound: 1 }] };
    });
    expect(validateScriptV2(missing).some((i) => i.path.includes("guaranteedPublicClues") && i.level === "error")).toBe(true);
    const privateDoc = cloneWith((d) => {
      d.clues[0].policy = "keep_private";
      d.hostGuide = { guaranteedPublicClues: [{ clueId: d.clues[0].id, deadlineRound: 1 }] };
    });
    expect(validateScriptV2(privateDoc).some((i) => i.message.includes("keep_private") && i.level === "error")).toBe(true);
  });

  it("线索 release 循环与全角色禁搜会阻断可玩性", () => {
    const circular = cloneWith((d) => {
      d.clues[0].release = { afterCluePublicIds: [d.clues[1].id] };
      d.clues[1].release = { afterCluePublicIds: [d.clues[0].id] };
    });
    expect(validateScriptV2(circular).some((i) => i.level === "error" && i.message.includes("循环"))).toBe(true);
    const unreachable = cloneWith((d) => {
      d.clues[0].forbiddenCharacterIds = d.characters.map((c: { id: string }) => c.id);
    });
    expect(validateScriptV2(unreachable).some((i) => i.level === "error" && i.message.includes("不可达"))).toBe(true);
  });

  it("技能卡与行动点字段可解析；cost 超过每轮行动点 → warning", () => {
    const d2 = cloneWith((d) => {
      d.flow.actionPointsPerRound = 1;
      d.characters[1].privateCard.skills = [
        { id: "confront", name: "当场对质", description: "要求一名 AI 当众正面回答", cost: 2, phase: "DISCUSSION", effect: "verify", once: true },
      ];
    });
    expect(d2.flow.actionPointsPerRound).toBe(1);
    expect(d2.characters[1].privateCard.skills[0].name).toBe("当场对质");
    const issues = validateScriptV2(d2);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("超过每轮行动点"))).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("技能默认值：cost=1/phase=DISCUSSION/effect=verify/once=true，且默认 actionPointsPerRound=0", () => {
    const d2 = cloneWith((d) => {
      d.characters[1].privateCard.skills = [{ id: "probe", name: "试探", description: "问一句" }];
    });
    const s = d2.characters[1].privateCard.skills[0];
    expect(s.cost).toBe(1);
    expect(s.phase).toBe("DISCUSSION");
    expect(s.effect).toBe("verify");
    expect(s.once).toBe(true);
    expect(doc.flow.actionPointsPerRound).toBe(0);
  });

  it("voteMode/quiz 默认值：culprit + 空 quiz，旧剧本零改动", () => {
    expect(doc.flow.voteMode).toBe("culprit");
    expect(doc.ending.quiz).toEqual([]);
  });

  it("voteMode=choice + quiz 可解析；choice 无 quiz → error；culprit 带 quiz → warning", () => {
    const choiceNoQuiz = cloneWith((d) => {
      d.flow.voteMode = "choice";
    });
    expect(validateScriptV2(choiceNoQuiz).some((i) => i.level === "error" && i.message.includes("复盘答题"))).toBe(true);
    const culpritWithQuiz = cloneWith((d) => {
      d.ending.quiz = [{ id: "q1", prompt: "凶器？", options: [{ id: "a", label: "簪" }, { id: "b", label: "刀" }], correctOptionId: "a", weight: 1 }];
    });
    expect(validateScriptV2(culpritWithQuiz).some((i) => i.level === "warning" && i.message.includes("忽略 quiz"))).toBe(true);
    const choiceOk = cloneWith((d) => {
      d.flow.voteMode = "choice";
      d.ending.quiz = [
        { id: "q1", prompt: "凶器？", options: [{ id: "a", label: "簪" }, { id: "b", label: "刀" }], correctOptionId: "a", weight: 2 },
        { id: "q2", prompt: "时刻？", options: [{ id: "x", label: "九点" }, { id: "y", label: "十点" }], correctOptionId: "y" },
      ];
    });
    expect(choiceOk.flow.voteMode).toBe("choice");
    expect(choiceOk.ending.quiz[0].weight).toBe(2);
    expect(choiceOk.ending.quiz[1].weight).toBe(1);
    expect(validateScriptV2(choiceOk).filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("quiz：correctOptionId 不在选项内 → error；选项 id 重复 → error；题目 id 重复 → error", () => {
    const badCorrect = cloneWith((d) => {
      d.flow.voteMode = "hybrid";
      d.ending.quiz = [{ id: "q1", prompt: "凶器？", options: [{ id: "a", label: "簪" }, { id: "b", label: "刀" }], correctOptionId: "nope", weight: 1 }];
    });
    expect(validateScriptV2(badCorrect).some((i) => i.level === "error" && i.message.includes("正确项不在选项内"))).toBe(true);
    const dupOption = cloneWith((d) => {
      d.flow.voteMode = "hybrid";
      d.ending.quiz = [{ id: "q1", prompt: "凶器？", options: [{ id: "a", label: "簪" }, { id: "a", label: "刀" }], correctOptionId: "a", weight: 1 }];
    });
    expect(validateScriptV2(dupOption).some((i) => i.level === "error" && i.message.includes("重复选项 id"))).toBe(true);
    const dupQuestion = cloneWith((d) => {
      d.flow.voteMode = "hybrid";
      d.ending.quiz = [
        { id: "q1", prompt: "凶器？", options: [{ id: "a", label: "簪" }, { id: "b", label: "刀" }], correctOptionId: "a", weight: 1 },
        { id: "q1", prompt: "时刻？", options: [{ id: "x", label: "九点" }, { id: "y", label: "十点" }], correctOptionId: "y", weight: 1 },
      ];
    });
    expect(validateScriptV2(dupQuestion).some((i) => i.level === "error" && i.message.includes("重复 id: q1"))).toBe(true);
  });
});

describe("Validator 新规则", () => {
  it("R1 线索数超过 可搜上限(人数×轮数) → error", () => {
    const d2 = cloneWith((d) => {
      const limit = d.characters.length * d.flow.searchRounds;
      while (d.clues.length <= limit) {
        const index = d.clues.length;
        d.clues.push({ ...d.clues[0], id: `extra_clue_${index}`, name: `多出来的线索${index}` });
      }
    });
    const errors = validateScriptV2(d2).filter((i) => i.level === "error");
    expect(errors.some((e) => e.message.includes("超过可发现上限"))).toBe(true);
  });

  it("R1 反方向：线索数少于 人数×搜证轮数 → 只 warning，后段轮次必然有人空手", () => {
    const d2 = cloneWith((d) => {
      d.flow.searchRounds = 3; // 5 人 × 3 轮 = 15 张需求，样板只有 10 张
    });
    const issues = validateScriptV2(d2);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("少于可搜需求"))).toBe(true);
    expect(issues.some((i) => i.level === "error" && i.message.includes("少于可搜需求"))).toBe(false);
    expect(validateScriptV2(parseScriptDocV2(raw)).some((i) => i.message.includes("少于可搜需求"))).toBe(false);
  });

  it("R2 证据链单线索支撑 → warning；合法姓名关系不再误报", () => {
    const d2 = cloneWith((d) => {
      d.truth.evidenceChain = [{ id: "c1", clueIds: ["bottle"], conclusion: "毒源即凶器来源。" }];
      d.characters[1].privateCard.knowledge[0].content = [{ type: "paragraph", text: "你亲眼看见苏晚在书房出入。" }];
    });
    const issues = validateScriptV2(d2);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("单线索锁凶"))).toBe(true);
    expect(issues.some((i) => i.message.includes("真凶姓名"))).toBe(false);
  });

  it("stages 指向不存在的幕 → error", () => {
    const d2 = cloneWith((d) => {
      d.characters[1].privateCard.stages = [{ actId: "no_such_act", knowledge: [], objectives: [] }];
    });
    expect(validateScriptV2(d2).some((i) => i.level === "error" && i.message.includes("幕不存在"))).toBe(true);
  });

  const withClueText = (id: string, text: string) =>
    cloneWith((d) => {
      d.clues.find((c: any) => c.id === id).content = [{ type: "paragraph", text }];
    });

  it("样板种子本身不触发锁凶门禁", () => {
    const issues = validateScriptV2(parseScriptDocV2(raw));
    expect(issues.some((i) => i.message.includes("单卡锁凶") || i.message.includes("推理链条偏短"))).toBe(false);
  });

  it("一张卡给齐姓名＋行为＋明知且无出口 → error", () => {
    const d2 = withClueText("bottle", "瓶身标签上写着苏晚的名字，她明知沈万山在服镇静剂，仍催他把这杯茶一口喝干。");
    expect(validateScriptV2(d2).some((i) => i.level === "error" && i.message.includes("单卡锁凶"))).toBe(true);
  });

  it("点名加行为但留了观察出口：不报单卡锁凶", () => {
    const d2 = withClueText("bottle", "苏晚在传菜口催过酒，但没人看见她把什么东西放进杯子。");
    expect(validateScriptV2(d2).some((i) => i.message.includes("单卡锁凶"))).toBe(false);
  });

  it("第 1 轮两卡即可凑齐三要素 → warning", () => {
    const d2 = cloneWith((d) => {
      d.clues.find((c: any) => c.id === "missing_key").content = [{ type: "paragraph", text: "备用房卡全楼只有一张，登记簿上那晚领走它的是苏晚。" }];
      d.clues.find((c: any) => c.id === "teacup").content = [{ type: "paragraph", text: "杯沿指纹之外，还查到有人明知茶里有异物仍劝沈万山喝下。" }];
    });
    expect(validateScriptV2(d2).some((i) => i.level === "warning" && i.message.includes("推理链条偏短"))).toBe(true);
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
    const joined = buildPlayerContext(d2, state, 1, [], {}).messages.map((m) => m.content).join("\n");
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
    const later = buildPlayerContext(d2, stateOf("DISCUSSION", 2), 1, [], {}).messages.map((m) => m.content).join("\n");
    expect(later).toContain("【本幕新知】");
    expect(later).toContain("第二幕才知道的事");
    const earlier = buildPlayerContext(d2, stateOf("DISCUSSION", 1), 1, [], {}).messages.map((m) => m.content).join("\n");
    expect(earlier).not.toContain("【本幕新知】");
    expect(earlier).not.toContain("第二幕才知道的事");
  });

  it("公开切片不暴露 hostGuide/私卡", () => {
    const view = publicScriptViewV2(doc) as unknown as Record<string, unknown>;
    expect("hostGuide" in view).toBe(false);
    expect("truth" in view).toBe(false);
  });

  it("角色卡可以在关系或目击中明确提及其他角色", () => {
    const d2 = cloneWith((d: any) => {
      const culpritName = d.characters.find((c: any) => c.id === d.truth.culpritId).name;
      const innocent = d.characters.find((c: any) => c.id !== d.truth.culpritId);
      innocent.privateCard.secrets[0].content = [{ type: "paragraph", text: `你亲眼看见${culpritName}行凶。` }];
      innocent.privateCard.backstory = [{ type: "paragraph", text: `你的旧怨源于${culpritName}。` }];
      innocent.privateCard.objectives[0].content = [{ type: "paragraph", text: `让别人的嘴说出${culpritName}三个字。` }];
    });
    const issues = validateScriptV2(d2).filter((i) => i.message.includes("真凶姓名"));
    expect(issues).toHaveLength(0);
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
    const dmJoined = buildDmContext(d2, state, [], { task: "控场" }).messages.map((m) => m.content).join("\n");
    expect(dmJoined).toContain("手册密语");
    for (let seat = 0; seat < d2.characters.length; seat++) {
      const playerJoined = buildPlayerContext(d2, state, seat, [], {}).messages.map((m) => m.content).join("\n");
      expect(playerJoined).not.toContain("手册密语");
    }
  });

  it("幕旁白与 hostGuide 同级：只进 DM 上下文，绝不进玩家上下文", () => {
    const d2 = cloneWith((d) => {
      d.flow.acts = [{ id: "act_1", title: "第一幕：冰源", roundStart: 1, brief: [{ type: "paragraph", text: "幕旁白密令：不宣布唯一经手人" }] }];
    });
    const state = stateOf("SEARCH", 1);
    const dmJoined = buildDmContext(d2, state, [], { task: "控场" }).messages.map((m) => m.content).join("\n");
    expect(dmJoined).toContain("幕旁白密令");
    for (let seat = 0; seat < d2.characters.length; seat++) {
      const playerJoined = buildPlayerContext(d2, state, seat, [], {}).messages.map((m) => m.content).join("\n");
      expect(playerJoined).not.toContain("幕旁白密令");
    }
  });
});
