import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDoc } from "@/core/script/schema";
import { guardDmSpeech, guardPlayerSpeech } from "./guard";
import { buildDmContext, buildPlayerContext } from "./context";
import { initialState } from "@/core/engine/state";
import type { EngineEvent } from "@/core/engine/types";

const doc = parseScriptDoc(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

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
      const msgs = buildPlayerContext(doc, state, seat, events, {});
      const joined = msgs.map((m) => m.content).join("\n");
      expect(joined).not.toContain(doc.truth.method.slice(0, 12));
      expect(joined).not.toContain(doc.truth.fullTimeline.slice(0, 12));
      // 其他角色的秘密
      for (const c of doc.characters) {
        if (c.id === state.seats[seat].characterId) continue;
        expect(joined).not.toContain(c.card.secret.slice(0, 10));
      }
    }
  });

  it("凶手玩家的上下文包含隐瞒策略，好人上下文包含诚实策略", () => {
    const culpritMsgs = buildPlayerContext(doc, state, 0, events, {}).map((m) => m.content).join("\n");
    expect(culpritMsgs).toContain("你就是真凶");
    const goodMsgs = buildPlayerContext(doc, state, 2, events, {}).map((m) => m.content).join("\n");
    expect(goodMsgs).toContain("你是无辜者之一");
  });

  it("玩家上下文包含自己的角色卡但不含别人的", () => {
    const msgs = buildPlayerContext(doc, state, 1, events, {}).map((m) => m.content).join("\n");
    const zhoubo = doc.characters.find((c) => c.id === "zhoubo")!;
    const suwan = doc.characters.find((c) => c.id === "suwan")!;
    expect(msgs).toContain(zhoubo.card.secret.slice(0, 8));
    expect(msgs).not.toContain(suwan.card.secret.slice(0, 8));
  });

  it("DM 上下文在复盘前不含手法，复盘时才给真相", () => {
    const before = buildDmContext(doc, state, events, { task: "test" }).map((m) => m.content).join("\n");
    expect(before).toContain("严禁出现真凶姓名");
    expect(before).not.toContain(doc.truth.method.slice(0, 8));
    const revealState = { ...state, phase: "REVEAL" as const };
    const after = buildDmContext(doc, revealState, events, { task: "test" }).map((m) => m.content).join("\n");
    const culprit = doc.characters.find((c) => c.id === doc.truth.culprit)!;
    expect(after).toContain(culprit.name);
    expect(after).toContain(doc.truth.method.slice(0, 8));
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
    const culprit = doc.characters.find((c) => c.id === doc.truth.culprit)!;
    const result = guardDmSpeech(doc, state, `欢迎来到云澜山庄。凶手其实是${culprit.name}。锁在箱子里的账本很关键。请开始搜证。`);
    expect(result.leaked.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(culprit.name);
    expect(result.text).not.toContain("锁在箱子里的账本");
    expect(result.text).toContain("请开始搜证");
  });

  it("复盘阶段允许宣读真相", () => {
    const state = makeState();
    state.phase = "REVEAL";
    const culprit = doc.characters.find((c) => c.id === doc.truth.culprit)!;
    const result = guardDmSpeech(doc, state, `凶手是${culprit.name}。`);
    expect(result.leaked).toEqual([]);
    expect(result.text).toContain(culprit.name);
  });
});
