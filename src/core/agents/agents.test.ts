import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { methodText, narrativeToText } from "@/core/script/compat";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { guardDmSpeech, guardPlayerSpeech } from "./guard";
import { buildDmContext, buildPlayerContext } from "./context";
import { composeSegments } from "@/core/llm/prompt-segments";
import { initialState } from "@/core/engine/state";
import type { EngineEvent } from "@/core/engine/types";

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

/** builder 现返回 PromptAssembly；这些 helper 取纯消息，测试断言仍针对最终 prompt */
const playerMsgs = (...args: Parameters<typeof buildPlayerContext>) => buildPlayerContext(...args).messages;
const dmMsgs = (...args: Parameters<typeof buildDmContext>) => buildDmContext(...args).messages;

/** 构造一个测试对局：座位 0=苏晚(凶手AI) 1=周伯 2=沈青禾 3=白慕森 4=陆小开 */
function makeState() {
  const order = ["suwan", "zhoubo", "qinghe", "baimusen", "luxiaokai"];
  const state = initialState(
    order.map((characterId, index) => ({ index, kind: "ai" as const, characterId, playerName: `AI${index}` }))
  );
  state.phase = "DISCUSSION";
  state.round = 1;
  // 座位 1（周伯）持有未公开线索「锁在箱子里的账本」
  const ledger = doc.clues.find((c) => c.id === "ledger")!;
  state.clueStates[ledger.id] = { discoveredBy: 1, isPublic: false };
  state.heldClues[1] = [ledger.id];
  return state;
}

describe("信息防火墙", () => {
  const state = makeState();
  const events: EngineEvent[] = [];

  it("玩家上下文绝不包含真相与其他角色的秘密/私卡", () => {
    for (let seat = 0; seat < 5; seat++) {
      const msgs = playerMsgs(doc, state, seat, events, {});
      const joined = msgs.map((m) => m.content).join("\n");
      expect(joined).not.toContain(methodText(doc).slice(0, 12));
      expect(joined).not.toContain(narrativeToText(doc.truth.timeline[0]?.content ?? []).slice(0, 12));
      for (const c of doc.characters) {
        if (c.id === state.seats[seat].characterId) continue;
        expect(joined).not.toContain(narrativeToText(c.privateCard.secrets[0].content).slice(0, 10));
      }
    }
  });

  it("凶手玩家的上下文包含隐瞒策略，好人上下文以自保为主而不是全能侦探", () => {
    const culpritMsgs = playerMsgs(doc, state, 0, events, {}).map((m) => m.content).join("\n");
    expect(culpritMsgs).toContain("你就是真凶");
    const goodMsgs = playerMsgs(doc, state, 2, events, {}).map((m) => m.content).join("\n");
    expect(goodMsgs).toContain("你是无辜者之一");
    expect(goodMsgs).toContain("第一目标是保护自己的秘密");
    expect(goodMsgs).not.toContain("你的目标是找出真凶并让大家相信你");
  });

  it("私聊和质询使用独立的阶段指令，不再与圆桌禁令冲突", () => {
    const whisper = playerMsgs(doc, state, 1, [], { taskType: "whisper", hint: "交换账本线索" }).map((m) => m.content).join("\n");
    expect(whisper).toContain("私聊窗口");
    expect(whisper).not.toContain("禁止私聊");
    const answer = playerMsgs(doc, state, 1, [], { taskType: "answer", hint: "回应脚印问题" }).map((m) => m.content).join("\n");
    expect(answer).toContain("质询回应");
    expect(answer).toContain("正面回答");
  });

  it("玩家上下文包含自己的角色卡但不含别人的", () => {
    const msgs = playerMsgs(doc, state, 1, events, {}).map((m) => m.content).join("\n");
    const zhoubo = doc.characters.find((c) => c.id === "zhoubo")!;
    const suwan = doc.characters.find((c) => c.id === "suwan")!;
    expect(msgs).toContain(narrativeToText(zhoubo.privateCard.secrets[0].content).slice(0, 8));
    expect(msgs).not.toContain(narrativeToText(suwan.privateCard.secrets[0].content).slice(0, 8));
  });

  it("同一座位的 system 不随事件、线索、阶段变化，事件只追加在 user", () => {
    const s1 = makeState();
    const ev: EngineEvent = {
      seq: "1",
      type: "speech",
      phase: "SELF_INTRO",
      round: 1,
      fromSeat: 0,
      toSeat: null,
      visibility: "public",
      content: { text: "大家好，我是苏晚。", speakerName: "苏晚" },
      createdAt: new Date().toISOString(),
    };
    const a = playerMsgs(doc, s1, 2, [], {});
    const s2 = makeState();
    s2.phase = "SEARCH";
    s2.round = 1;
    const ledger = doc.clues.find((c) => c.id === "ledger")!;
    s2.heldClues[2] = [ledger.id];
    s2.clueStates[ledger.id] = { discoveredBy: 2, isPublic: false };
    const b = playerMsgs(doc, s2, 2, [ev], { hint: "请接话" });
    expect(a[0].role).toBe("system");
    expect(a[0].content).toBe(b[0].content);
    expect(a[0].content).not.toContain(ledger.name);
    expect(b[1].content).toContain(ledger.name);
    expect(b[1].content.startsWith("【到目前为止的现场记录】")).toBe(true);
    expect(b[1].content).toContain("大家好，我是苏晚。");
  });

  it("DM 的 system 整局不变：任务、线索发现、复盘都只改 user 尾部", () => {
    const ev: EngineEvent = {
      seq: "1",
      type: "speech",
      phase: "SELF_INTRO",
      round: 1,
      fromSeat: 0,
      toSeat: null,
      visibility: "public",
      content: { text: "我先说两句。", speakerName: "苏晚" },
      createdAt: new Date().toISOString(),
    };
    const s1 = makeState();
    const a = dmMsgs(doc, s1, [], { task: "开场旁白" });
    const s2 = makeState();
    s2.phase = "SEARCH";
    s2.round = 2;
    const b = dmMsgs(doc, s2, [ev], { task: "转入搜证" });
    const s3 = makeState();
    s3.phase = "REVEAL";
    const c = dmMsgs(doc, s3, [ev], { task: "揭晓真相" });
    expect(a[0].content).toBe(b[0].content);
    expect(b[0].content).toBe(c[0].content);
    expect(a[0].content).not.toContain("开场旁白");
    expect(b[1].content).toContain("转入搜证");
    expect(c[1].content).toContain("揭晓真相");
    const logB = b[1].content.split("\n\n【当前局面】")[0];
    const logC = c[1].content.split("\n\n【当前局面】")[0];
    expect(logC.startsWith(logB.trimEnd())).toBe(true);
  });

  it("复盘前 DM 上下文不含真相和角色私卡，复盘时才在尾部给出", () => {
    const s1 = makeState();
    const before = dmMsgs(doc, s1, [], { task: "开场旁白" }).map((m) => m.content).join("\n");
    expect(before).not.toContain("真凶：");
    expect(before).not.toContain(methodText(doc).slice(0, 12));
    expect(before).not.toContain("（真凶）");
    const suwan = doc.characters.find((c) => c.id === "suwan")!;
    expect(before).not.toContain(narrativeToText(suwan.privateCard.secrets[0].content).slice(0, 12));
    const revealState = { ...s1, phase: "REVEAL" as const };
    const after = dmMsgs(doc, revealState, [], { task: "揭晓真相" }).map((m) => m.content).join("\n");
    expect(after).toContain("真凶：");
    expect(after).toContain(methodText(doc).slice(0, 8));
    expect(after.split("【可以宣读的真相】")[0]).not.toContain(methodText(doc).slice(0, 12));
  });

  it("玩家现场记录只追加，不改写已有前缀", () => {
    const ev1: EngineEvent = {
      seq: "1",
      type: "speech",
      phase: "SELF_INTRO",
      round: 1,
      fromSeat: 0,
      toSeat: null,
      visibility: "public",
      content: { text: "第一句。", speakerName: "苏晚" },
      createdAt: new Date().toISOString(),
    };
    const ev2: EngineEvent = {
      ...ev1,
      seq: "2",
      content: { text: "第二句。", speakerName: "周伯" },
      fromSeat: 1,
    };
    const state = makeState();
    const u1 = playerMsgs(doc, state, 2, [ev1], {})[1].content;
    const u2 = playerMsgs(doc, state, 2, [ev1, ev2], {})[1].content;
    const log1 = u1.split("\n\n【你持有的线索卡】")[0];
    const log2 = u2.split("\n\n【你持有的线索卡】")[0];
    expect(log2.startsWith(log1.trimEnd())).toBe(true);
    expect(log2).toContain("第二句。");
  });

  it("语气死锁与行为禁令位于 tail 近因区，不再驻留 system", () => {
    const msgs = playerMsgs(doc, state, 1, events, { requireJson: '输出 JSON：{"text":"…"}' });
    expect(msgs[0].content).not.toContain("【发言要求】");
    expect(msgs[0].content).not.toContain("红线（");
    const user = msgs[1].content;
    expect(user.indexOf("【发言要求】")).toBeGreaterThan(user.indexOf("【你持有的线索卡】"));
    expect(user.indexOf("【发言要求】")).toBeLessThan(user.indexOf("输出 JSON"));
  });

  it("红线跟随发言要求进入近因区尾部", () => {
    const patched = structuredClone(doc);
    patched.characters.find((c) => c.id === "zhoubo")!.privateCard.violation = ["绝不能提及灯塔暗号"];
    const user = playerMsgs(patched, state, 1, events, {})[1].content;
    expect(user).toContain("红线（无论如何不能说破、不能做）：绝不能提及灯塔暗号");
    expect(user.indexOf("红线（")).toBeGreaterThan(user.indexOf("【发言要求】"));
  });

  it("玩家分段结构：线索卡锚定，召回/证据登记/可打出的牌按序可丢", () => {
    const { segments } = buildPlayerContext(doc, state, 1, events, { recall: "【旧事重提】\n· 苏晚：旧话" });
    expect(segments.anchoredHead.startsWith("【你持有的线索卡】")).toBe(true);
    expect(segments.anchoredTail).toContain("【发言要求】");
    expect(segments.anchoredTail).toContain("圆桌讨论");
    expect(segments.droppable[0]).toContain("旧事重提");
    expect(composeSegments(segments)).toEqual(buildPlayerContext(doc, state, 1, events, { recall: "【旧事重提】\n· 苏晚：旧话" }).messages);
  });

  it("DM 禁令与发言要求同样移入 tail，紧贴任务之后", () => {
    const msgs = dmMsgs(doc, state, events, { task: "控场", requireJson: "输出 JSON" });
    expect(msgs[0].content).not.toContain("复盘前严禁");
    expect(msgs[0].content).not.toContain("主持人旁白口吻");
    const user = msgs[1].content;
    expect(user.indexOf("【你的任务】")).toBeLessThan(user.indexOf("复盘前严禁"));
    expect(user.indexOf("主持人旁白口吻")).toBeLessThan(user.indexOf("输出 JSON"));
  });
});

describe("输出守卫", () => {
  it("拦截泄露他人未公开线索的发言", () => {
    const state = makeState();
    const result = guardPlayerSpeech(doc, state, 2, "我觉得周伯有问题，他那本锁在箱子里的账本肯定藏着什么。而且我昨晚看到他偷偷摸摸。");
    expect(result.leaked).toContain("锁在箱子里的账本");
    expect(result.text).not.toContain("锁在箱子里的账本");
    expect(result.text).toContain("我昨晚看到他偷偷摸摸");
  });

  it("允许玩家转述自己持有的线索", () => {
    const state = makeState();
    const result = guardPlayerSpeech(doc, state, 1, "我招了，账本上的钱是我挪用的，跟案子无关！");
    expect(result.leaked).toEqual([]);
  });

  it("允许提及已公开的线索", () => {
    const state = makeState();
    const ledger = doc.clues.find((c) => c.id === "ledger")!;
    state.clueStates[ledger.id].isPublic = true;
    const result = guardPlayerSpeech(doc, state, 3, "账本的事大家都知道了，但这说明周伯缺钱。");
    expect(result.leaked).toEqual([]);
  });
});

describe("DM 旁白守卫", () => {
  it("复盘前剥掉真凶名和未公开线索", () => {
    const state = makeState();
    const culprit = doc.characters.find((c) => c.id === doc.truth.culpritId)!;
    const result = guardDmSpeech(doc, state, `欢迎来到云澜山庄。凶手其实是${culprit.name}。锁在箱子里的账本很关键。请开始搜证。`);
    expect(result.leaked.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(culprit.name);
    expect(result.text).not.toContain("锁在箱子里的账本");
    expect(result.text).toContain("请开始搜证");
  });

  it("复盘阶段允许宣读真相", () => {
    const state = makeState();
    state.phase = "REVEAL";
    const culprit = doc.characters.find((c) => c.id === doc.truth.culpritId)!;
    const result = guardDmSpeech(doc, state, `凶手是${culprit.name}。`);
    expect(result.leaked).toEqual([]);
    expect(result.text).toContain(culprit.name);
  });
});
