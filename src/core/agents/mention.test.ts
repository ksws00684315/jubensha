import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { mentionedAiSeats, MAX_INTERJECTIONS_PER_ROUND } from "./mention";
import { lastOwnSpeechText, shouldReviewSpeech } from "./review";
import { initialState } from "@/core/engine/state";
import type { GameState } from "@/core/engine/types";

const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8")));

function makeState(kindBySeat: Array<"ai" | "human" | "empty"> = ["ai", "ai", "ai", "ai", "ai"]): GameState {
  const order = ["suwan", "zhoubo", "qinghe", "baimusen", "luxiaokai"];
  const state = initialState(
    order.map((characterId, index) => ({
      index,
      kind: kindBySeat[index] ?? "empty",
      characterId,
      playerName: `P${index}`,
    }))
  );
  state.phase = "DISCUSSION";
  state.round = 1;
  return state;
}

const nameOf = (id: string) => doc.characters.find((c) => c.id === id)!.name;

describe("mention 插话调度", () => {
  it("点名 AI 角色名时激活对应座位，按提及顺序返回", () => {
    const state = makeState();
    const zhoubo = nameOf("zhoubo");
    const qinghe = nameOf("qinghe");
    const hits = mentionedAiSeats(doc, state, `我觉得${qinghe}和${zhoubo}都有嫌疑。`);
    expect(hits).toContain(2);
    expect(hits).toContain(1);
    expect(hits[0]).toBe(2);
  });

  it("跳过真人/空座和自己，没点名时返回空", () => {
    const state = makeState(["human", "ai", "ai", "empty", "empty"]);
    const suwan = nameOf("suwan");
    expect(mentionedAiSeats(doc, state, `我怀疑${suwan}。`, 0)).toEqual([]);
    expect(mentionedAiSeats(doc, state, "大家都有嫌疑。")).toEqual([]);
    expect(mentionedAiSeats(doc, state, "  ")).toEqual([]);
  });

  it("每轮插话次数有上限", () => {
    expect(MAX_INTERJECTIONS_PER_ROUND).toBeGreaterThanOrEqual(1);
    expect(MAX_INTERJECTIONS_PER_ROUND).toBeLessThanOrEqual(5);
  });
});

describe("二次审查启发式", () => {
  it("出戏元话语触发送审", () => {
    expect(shouldReviewSpeech("作为一个AI助手，我建议大家投票给周伯。", null)).toBe(true);
    expect(shouldReviewSpeech("这里是不是剧本杀的机制环节？", null)).toBe(true);
  });

  it("与上一段发言开头复读触发送审", () => {
    expect(shouldReviewSpeech("我觉得周伯有很大嫌疑，账本说明一切。", "我觉得周伯有很大嫌疑，但证据不足。")).toBe(true);
  });

  it("正常戏内台词不触发", () => {
    expect(shouldReviewSpeech("我当时在书房整理文件，没听见什么动静。", "晚饭后我回房间休息了。")).toBe(false);
    expect(shouldReviewSpeech("", null)).toBe(false);
  });

  it("lastOwnSpeechText 找该座位最近一次发言", () => {
    const events = [
      { type: "speech", fromSeat: 1, content: { text: "第一句" } },
      { type: "speech", fromSeat: 2, content: { text: "别人的" } },
      { type: "speech", fromSeat: 1, content: { text: "我最近的发言" } },
      { type: "system", fromSeat: null, content: { text: "系统消息" } },
    ];
    expect(lastOwnSpeechText(events, 1)).toBe("我最近的发言");
    expect(lastOwnSpeechText(events, 3)).toBeNull();
  });
});
