/* eslint-disable @typescript-eslint/no-explicit-any -- 测试助手需要以 any 就地改动种子 JSON */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDocV2 } from "./v2/schema";
import { analyzeClue, computeLockMetric, isSingleCardLock } from "./lock-metric";

const raw = JSON.parse(readFileSync(path.join(process.cwd(), "seeds/generated/5p-diqifengheka.json"), "utf-8"));

function cloneWith(mutate: (d: any) => void) {
  const copy = JSON.parse(JSON.stringify(raw));
  mutate(copy);
  return parseScriptDocV2(copy);
}

/** 把某张卡改写成指定正文，其余结构不动 */
function withClueText(id: string, text: string) {
  return cloneWith((d) => {
    const clue = d.clues.find((c: any) => c.id === id);
    clue.content = [{ type: "paragraph", text }];
  });
}

describe("单卡锁凶判定", () => {
  it("点名＋行为＋明知同落一人且无落空点：判为单卡锁凶", () => {
    const doc = withClueText("fuwuyuan_zhengci", "赵凯明知郑国栋在吃头孢，仍催他连干三杯，说不喝就是不给他面子。");
    const facts = analyzeClue(doc, doc.clues.find((c) => c.id === "fuwuyuan_zhengci")!);
    expect(facts.accusing).toBe(true);
    expect(facts.knowing).toBe(true);
    expect(facts.exculpated).toBe(false);
    expect(isSingleCardLock(facts)).toBe(true);
    expect(computeLockMetric(doc).rounds[0].singleCardClueIds).toContain("fuwuyuan_zhengci");
  });

  /** 这张卡曾经三要素齐备又无出口，是玩家抱怨"一卡锁凶"的那张；判词搬进 hostGuide 后不得回退 */
  it("样板种子里不再有任何单卡锁凶、卡内判词或抹名目击", () => {
    const report = computeLockMetric(parseScriptDocV2(raw));
    expect(report.culpritName).toBe("赵凯");
    expect(report.rounds.every((r) => r.singleCardClueIds.length === 0)).toBe(true);
    expect(report.verdictClueIds).toEqual([]);
    expect(report.blankedWitnesses).toEqual([]);
  });

  it("姓名只在受话人位置（听见老板对白某说）不算明知", () => {
    const doc = withClueText("fuwuyuan_zhengci", "伙计听见经理对白秋池说账目年底要说清，又让他把门锁上半个钟。");
    expect(analyzeClue(doc, doc.clues.find((c) => c.id === "fuwuyuan_zhengci")!).knowing).toBe(false);
  });

  it("免责句里的姓名不算明知，卡上的观察出口同样抵消锁凶", () => {
    const exculpated = withClueText("fuwuyuan_zhengci", "赵凯催郑国栋饮酒并说药不差这一会儿，但没人看见杯中是否有胶囊。");
    expect(analyzeClue(exculpated, exculpated.clues.find((c) => c.id === "fuwuyuan_zhengci")!).exculpated).toBe(true);
    const negated = withClueText("fuwuyuan_zhengci", "赵凯催郑国栋饮酒，记录也不能证明他知道药与酒相冲。");
    expect(analyzeClue(negated, negated.clues.find((c) => c.id === "fuwuyuan_zhengci")!).knowing).toBe(false);
  });

  it("只点名不写行为：不算单卡，但两卡口径仍能对照", () => {
    const doc = withClueText("fuwuyuan_zhengci", "陈曼记得那天赵凯也在包厢里，其余经过她说不清。");
    const facts = analyzeClue(doc, doc.clues.find((c) => c.id === "fuwuyuan_zhengci")!);
    expect(facts.culpritTerms.length).toBeGreaterThan(0);
    expect(isSingleCardLock(facts)).toBe(false);
  });
});

describe("第 k 轮可见性折算", () => {
  const rounds = (doc: ReturnType<typeof parseScriptDocV2>) => computeLockMetric(doc).rounds;

  it("auto_public 进共见，manual_public 只进持有", () => {
    const view = rounds(parseScriptDocV2(raw))[0];
    expect(view.shared).toContain("jizhen_jilu");
    expect(view.held).toContain("fuwuyuan_zhengci");
    expect(view.shared).not.toContain("fuwuyuan_zhengci");
  });

  it("release.round 未到的卡本轮不出现；到轮才可能被看到", () => {
    const doc = cloneWith((d) => {
      d.flow.searchRounds = 2;
      d.hostGuide.guaranteedPublicClues = [];
      d.clues.find((c: any) => c.id === "fuwuyuan_zhengci").release = { round: 2, afterCluePublicIds: [] };
    });
    const [r1, r2] = rounds(doc);
    expect(r1.held).not.toContain("fuwuyuan_zhengci");
    expect(r1.shared).not.toContain("fuwuyuan_zhengci");
    expect(r2.held).toContain("fuwuyuan_zhengci");
  });

  it("主持保证公开的卡到截止轮进入共见", () => {
    const doc = cloneWith((d) => {
      d.hostGuide = { perPhase: [], stallBreakers: [], guaranteedPublicClues: [{ clueId: "fuwuyuan_zhengci", deadlineRound: 2 }] };
    });
    const [r1, r2] = rounds(doc);
    expect(r1.shared).not.toContain("fuwuyuan_zhengci");
    expect(r2.shared).toContain("fuwuyuan_zhengci");
    expect(r2.held).not.toContain("fuwuyuan_zhengci");
  });

  it("全员禁搜的卡不进任何一层", () => {
    const doc = cloneWith((d) => {
      d.clues.find((c: any) => c.id === "fuwuyuan_zhengci").forbiddenCharacterIds = d.characters.map((c: any) => c.id);
    });
    const view = rounds(doc)[0];
    expect(view.held).not.toContain("fuwuyuan_zhengci");
    expect(view.shared).not.toContain("fuwuyuan_zhengci");
  });
});

describe("抹名式目击", () => {
  it("亲见＋模糊代词记为一条", () => {
    const doc = cloneWith((d) => {
      d.characters[2].privateCard.knowledge = [
        { id: "k_blank", title: "走廊那一幕", content: [{ type: "paragraph", text: "20:40 你在走廊亲眼看见有人让服务员换酒。" }], source: "witnessed", relatedCharacterIds: [], relatedClueIds: [] },
      ];
    });
    const hits = computeLockMetric(doc).blankedWitnesses;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].excerpt).toContain("有人");
  });

  it("点名目击不误报", () => {
    const doc = cloneWith((d) => {
      d.characters[2].privateCard.isCulprit = false;
      d.characters[2].privateCard.knowledge = [
        { id: "k_named", title: "走廊那一幕", content: [{ type: "paragraph", text: "20:40 你亲眼看见赵凯在传菜口递钱换酒，当时以为他在张罗酒水。" }], source: "witnessed", relatedCharacterIds: [], relatedClueIds: [] },
      ];
    });
    expect(computeLockMetric(doc).blankedWitnesses.some((h) => h.excerpt.includes("亲眼看见赵凯"))).toBe(false);
  });
});

describe("判词卡", () => {
  it("卡内出现证明类判词即计入清单", () => {
    const doc = withClueText("huanjiu_bianqian", "这张便签不能证明递钱者是谁，只能说明当晚确有人催促上酒。");
    expect(computeLockMetric(doc).verdictClueIds).toContain("huanjiu_bianqian");
  });
});
