import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { narrativeToText } from "@/core/script/compat";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { buildPlayerContext } from "./context";
import { createSpeechRedactor, dmGuardMarkers, guardPlayerSpeech, playerGuardMarkers } from "./guard";
import {
  buildSummarizeMessages,
  clueMentionHints,
  pendingHeadChars,
  planMemorySplit,
  renderLogWithMemory,
} from "./memory";
import { initialState, renderEventLog } from "@/core/engine/state";
import type { EngineEvent, GameState } from "@/core/engine/types";

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

/** 构造一个测试对局：座位 0=苏晚(凶手AI) 1=周伯 2=沈青禾 3=白慕森 4=陆小开；座位 1 持有未公开线索「账本」 */
function makeState(): GameState {
  const order = ["suwan", "zhoubo", "qinghe", "baimusen", "luxiaokai"];
  const state = initialState(
    order.map((characterId, index) => ({ index, kind: "ai" as const, characterId, playerName: `AI${index}` }))
  );
  state.phase = "DISCUSSION";
  state.round = 1;
  const ledger = doc.clues.find((c) => c.id === "ledger")!;
  state.clueStates[ledger.id] = { discoveredBy: 1, isPublic: false };
  state.heldClues[1] = [ledger.id];
  return state;
}

function speechEv(seq: string, fromSeat: number, text: string): EngineEvent {
  return {
    seq,
    type: "speech",
    phase: "DISCUSSION",
    round: 1,
    fromSeat,
    toSeat: null,
    visibility: "public",
    content: { text, speakerName: `玩家${fromSeat + 1}` },
    createdAt: new Date().toISOString(),
  };
}

describe("分层记忆", () => {
  it("短对局不产生摘要头", () => {
    const events = Array.from({ length: 6 }, (_, i) => speechEv(String(i + 1), i % 5, `第${i + 1}条发言，内容不长。`));
    const { head, tail } = planMemorySplit(events);
    expect(head).toHaveLength(0);
    expect(tail).toHaveLength(6);
  });

  it("长对局切出摘要头，近期窗口逐字保留", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      speechEv(String(i + 1), i % 5, `第${i + 1}条发言。${"现场内容".repeat(60)}`)
    );
    const { head, tail } = planMemorySplit(events);
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThanOrEqual(8);
    // 尾窗渲染长度约等于预算（允许多出最后一条事件）
    const tailChars = renderEventLog(tail, null).length;
    expect(tailChars).toBeGreaterThanOrEqual(6000);
    expect(tailChars).toBeLessThan(8200);
    // 头 + 尾必须无缝覆盖全部事件
    expect(head.length + tail.length).toBe(60);
    expect(tail[0].seq).toBe(String(head.length + 1));
  });

  it("pendingHeadChars 以锚点为界计算待摘要增量", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      speechEv(String(i + 1), i % 5, `第${i + 1}条发言。${"现场内容".repeat(60)}`)
    );
    const { head } = planMemorySplit(events);
    const anchor = head[head.length - 1];
    expect(pendingHeadChars(events, anchor.seq)).toBe(0);
    expect(pendingHeadChars(events, "")).toBe(renderEventLog(head, null).length);
    const mid = head[Math.floor(head.length / 2) - 1];
    const pendingMid = pendingHeadChars(events, mid.seq);
    expect(pendingMid).toBeGreaterThan(0);
    expect(pendingMid).toBeLessThan(renderEventLog(head, null).length);
  });

  it("有锚点时渲染为 概要 + 近期记录，且近期不含锚点前内容", () => {
    const events = [speechEv("1", 0, "很久以前的开场陈述内容。"), speechEv("2", 1, "刚刚的最新发言。")];
    const memory = { anchorSeq: "1", summary: "此前：苏晚自称清白。" };
    const text = renderLogWithMemory(events, null, memory, false);
    expect(text).toContain("【现场记录·此前概要】");
    expect(text).toContain("此前：苏晚自称清白。");
    expect(text).toContain("【最近的现场记录】");
    expect(text).toContain("刚刚的最新发言。");
    expect(text).not.toContain("很久以前的开场陈述内容");
  });

  it("锚点之后没有新事件时只输出概要；锚点失效时退回全量日志", () => {
    const events = [speechEv("1", 0, "唯一的发言。")];
    const onlySummary = renderLogWithMemory(events, null, { anchorSeq: "1", summary: "概要内容。" }, false);
    expect(onlySummary).toContain("概要内容。");
    expect(onlySummary).not.toContain("【最近的现场记录】");
    const fallback = renderLogWithMemory(events, null, { anchorSeq: "999", summary: "概要内容。" }, false);
    expect(fallback).toBe(renderEventLog(events, null));
    expect(fallback).toContain("唯一的发言。");
  });

  it("玩家视角走记忆渲染时，自己持有的线索仍完整出现在尾部线索卡里", () => {
    const state = makeState();
    state.memory = { anchorSeq: "5", summary: "概要。" };
    const events = [
      speechEv("5", 0, "早期发言。"),
      {
        ...speechEv("6", 1, ""),
        type: "clue" as const,
        visibility: "seat:1",
        content: { clueId: "ledger", clueName: "锁在箱子里的账本", clueContent: "账本内容", private: true },
      },
    ];
    const msgs = buildPlayerContext(doc, state, 1, events, {});
    const joined = msgs.map((m) => m.content).join("\n");
    expect(joined).toContain("【现场记录·此前概要】");
    expect(joined).toContain("锁在箱子里的账本");
  });

  it("摘要员 prompt 包含旧摘要与待压缩记录，并禁止推测真凶", () => {
    const msgs = buildSummarizeMessages("旧概要。", "新增记录。");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("不要指认谁是真凶");
    expect(msgs[1].content).toContain("旧概要。");
    expect(msgs[1].content).toContain("新增记录。");
  });
});

describe("世界书式线索提示", () => {
  it("别人提到我持有的私藏线索时给出提示", () => {
    const state = makeState();
    const events = [speechEv("1", 2, "我听说周伯家里有一把锁，还翻出过锁在箱子里的账本，对吧？")];
    expect(clueMentionHints(doc, state, 1, events)).toContain("锁在箱子里的账本");
    const joined = buildPlayerContext(doc, state, 1, events, {}).map((m) => m.content).join("\n");
    expect(joined).toContain("【可打出的牌】");
  });

  it("只有自己提过、或线索已公开、或没人提及时不给提示", () => {
    const state = makeState();
    const selfOnly = [speechEv("1", 1, "关于锁在箱子里的账本我想说两句。")];
    expect(clueMentionHints(doc, state, 1, selfOnly)).toEqual([]);
    const nobody = [speechEv("1", 2, "今天天气不错。")];
    expect(clueMentionHints(doc, state, 1, nobody)).toEqual([]);
    const publicState = makeState();
    publicState.clueStates["ledger"].isPublic = true;
    const mentioned = [speechEv("1", 2, "锁在箱子里的账本大家都看到了。")];
    expect(clueMentionHints(doc, publicState, 1, mentioned)).toEqual([]);
  });
});

describe("守卫升级：永不披露的秘密", () => {
  it("AI 念卡式说出自己 never 秘密原文时剥掉整句", () => {
    const state = makeState();
    const qinghe = doc.characters.find((c) => c.id === "qinghe")!;
    const secret = qinghe.privateCard.secrets[0];
    expect(secret.disclosure).toBe("never");
    const frag = narrativeToText(secret.content)
      .split(/[，。；：、（）()""\s]+/)
      .filter((s) => s.length >= 6)[0];
    const result = guardPlayerSpeech(doc, state, 2, `大家听好了，${frag}，就是这样。`);
    expect(result.leaked).toContain(secret.title);
    expect(result.text).not.toContain(frag);
  });

  it("守卫只盯自己的秘密：别人的秘密内容不在标记里（防火墙保证 AI 也看不到）", () => {
    const state = makeState();
    const markers = playerGuardMarkers(doc, state, 3).map((m) => m.value);
    const qinghe = doc.characters.find((c) => c.id === "qinghe")!;
    for (const secret of qinghe.privateCard.secrets) {
      const frags = narrativeToText(secret.content)
        .split(/[，。；：、（）()""\s]+/)
        .filter((s) => s.length >= 6)
        .slice(0, 5);
      for (const frag of frags) expect(markers).not.toContain(frag);
    }
  });
});

describe("流式增量守卫", () => {
  it("未跨句子边界不放行，泄露句整句吞掉，flush 返回剩余文本", () => {
    const state = makeState();
    const redactor = createSpeechRedactor(playerGuardMarkers(doc, state, 2));
    let out = "";
    out += redactor.push("我觉得周伯");
    expect(out).toBe("");
    out += redactor.push("有问题。而且我昨晚");
    expect(out).toBe("我觉得周伯有问题。");
    out += redactor.push("看到他那本锁在箱子里的账本。真的。");
    expect(out).toBe("我觉得周伯有问题。");
    const { delta, text, leaked } = redactor.flush();
    out += delta;
    expect(out).toBe("我觉得周伯有问题。真的。");
    expect(text).toBe(out);
    expect(leaked).toContain("锁在箱子里的账本");
  });

  it("复盘前 DM 流式守卫吞掉真凶名，复盘后放行全部", () => {
    const state = makeState();
    const culprit = doc.characters.find((c) => c.id === doc.truth.culpritId)!;
    const redactor = createSpeechRedactor(dmGuardMarkers(doc, state));
    let out = "";
    out += redactor.push(`欢迎来到云澜山庄。凶手其实是${culprit.name}。`);
    out += redactor.flush().delta;
    expect(out).toBe("欢迎来到云澜山庄。");
    const revealRedactor = createSpeechRedactor(dmGuardMarkers(doc, { ...state, phase: "REVEAL" }));
    let revealOut = "";
    revealOut += revealRedactor.push(`凶手是${culprit.name}。`);
    revealOut += revealRedactor.flush().delta;
    expect(revealOut).toContain(culprit.name);
  });
});
