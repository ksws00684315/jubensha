import { describe, expect, it } from "vitest";
import { deriveTimelineTitle, isPlaceholderTimelineTime, isPlaceholderTimelineTitle, isTruncatedTimelineText } from "./timeline";
import { timelineToText } from "../compat";

describe("isPlaceholderTimelineTitle", () => {
  it("识别机械占位标题（含全角/半角空格与多余空白）", () => {
    expect(isPlaceholderTimelineTitle("事件 1")).toBe(true);
    expect(isPlaceholderTimelineTitle(" 事件12 ")).toBe(true);
    expect(isPlaceholderTimelineTitle("事件")).toBe(false);
    expect(isPlaceholderTimelineTitle("事件一")).toBe(false);
    expect(isPlaceholderTimelineTitle("")).toBe(false);
    expect(isPlaceholderTimelineTitle(undefined)).toBe(false);
  });
});

describe("isPlaceholderTimelineTime", () => {
  it("识别未整理的时间占位值", () => {
    expect(isPlaceholderTimelineTime("时间待整理")).toBe(true);
    expect(isPlaceholderTimelineTime("待补充")).toBe(true);
    expect(isPlaceholderTimelineTime("子时末（约零时前后）")).toBe(false);
  });
});

describe("isTruncatedTimelineText", () => {
  it("首部是收尾符号、或尾部是开括号/箭头 → 判定为被截断", () => {
    expect(isTruncatedTimelineText("）→ 剑鞘血滴与蓝色纤维（凶器归位）")).toBe(true);
    expect(isTruncatedTimelineText("裴小北按傅崇礼口吻发高管群通知（")).toBe(true);
    expect(isTruncatedTimelineText("对讲静音，导播席位）→ 门禁补传记录（")).toBe(true);
  });

  it("完整句子不算截断", () => {
    expect(isTruncatedTimelineText("21:10 方晴送两杯茶进书房，听到争执。")).toBe(false);
    expect(isTruncatedTimelineText("")).toBe(false);
  });
});

describe("deriveTimelineTitle", () => {
  it("取第一个短句，去掉重复的时刻前缀、旁注括号与引导符号", () => {
    expect(deriveTimelineTitle("备战会结束，队员自由训练。")).toBe("备战会结束");
    expect(deriveTimelineTitle("21:10 方晴送两杯茶进书房，听到争执。")).toBe("方晴送两杯茶进书房");
    expect(deriveTimelineTitle("（悄悄）他去拿钥匙了。")).toBe("他去拿钥匙了");
  });

  it("在未闭合括号前砍断：截断正文的残留括号不进标题", () => {
    expect(deriveTimelineTitle("主控室核审计数据（值班日志有你的门禁记录")).toBe("主控室核审计数据");
    expect(deriveTimelineTitle("）→ 剑鞘血滴与蓝色纤维（凶器归位却留下痕迹）")).toBe("剑鞘血滴与蓝色纤维");
  });

  it("超长时截断并加省略号", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
    expect(deriveTimelineTitle(long)).toBe("一二三四五六七八九十一二三四五六七八九十…");
  });

  it("空正文返回空串（调用方保留原标题）", () => {
    expect(deriveTimelineTitle("   ")).toBe("");
  });
});

describe("timelineToText 占位标题兜底", () => {
  const entry = (title: string, display: string, text: string) => ({
    time: { display },
    title,
    content: [{ type: "paragraph" as const, text }],
  });

  it("占位标题被丢弃，退化为「时刻 + 正文」，不再出现「事件 N」", () => {
    const out = timelineToText([entry("事件 1", "21:10", "方晴送茶进书房。")]);
    expect(out).toBe("21:10 方晴送茶进书房。");
    expect(out).not.toContain("事件");
  });

  it("正常标题保持「时刻 标题：正文」格式", () => {
    expect(timelineToText([entry("送茶", "21:10", "方晴送茶进书房。")])).toBe("21:10 送茶：方晴送茶进书房。");
  });
});
