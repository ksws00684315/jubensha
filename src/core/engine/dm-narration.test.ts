import { describe, expect, it } from "vitest";
import { dmFallbackText } from "./turns";
import { voteBriefOf } from "./phases";

describe("DM 旁白降级文案（T1.1）", () => {
  it("各阶段降级文案固定中性，绝不内插 task 提示词", () => {
    const task = "直接进入案件复盘，不要重述开场背景。公布投票结果并点评玩家表现。";
    for (const phase of ["READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"] as const) {
      const text = dmFallbackText(phase);
      expect(text).toMatch(/^（主持人正在.+, 请稍候。|（主持人正在.+，请稍候。）$/);
      // 降级文案是固定常量：不含 task 的任何片段、不含指令性用语
      expect(text).not.toContain("不要");
      expect(text).not.toContain("点评");
      expect(text).not.toContain("复盘，");
      expect(text.endsWith("）")).toBe(true);
    }
    // 指令词必须只能来自 task 内插——2026-10-01 实测曾把整段提示词透传给玩家
    expect(dmFallbackText("REVEAL")).not.toContain(task.slice(0, 6));
  });

  it("每个阶段的降级文案互不相同且非空", () => {
    const phases = ["READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL"] as const;
    const texts = phases.map((p) => dmFallbackText(p));
    expect(new Set(texts).size).toBe(phases.length);
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(0);
  });
});

describe("复盘票数口播口径（T1.1）", () => {
  const nameOf = (seat: number) => (seat === 1 ? "周伯" : seat === 3 ? "苏晚" : `玩家${seat + 1}`);

  it("座位编号与 votes 表/事件流一致（0-based），并附角色名", () => {
    expect(voteBriefOf({ "1": 1, "3": 4 }, nameOf)).toBe("座位1（周伯）得 1 票，座位3（苏晚）得 4 票");
  });

  it("不再出现 2026-10-01 实测的 +1 错位口径（座位2/座位4）", () => {
    const text = voteBriefOf({ "1": 1, "3": 4 }, nameOf);
    expect(text).not.toContain("座位2");
    expect(text).not.toContain("座位4");
  });

  it("无人投票时给出占位文案", () => {
    expect(voteBriefOf({}, nameOf)).toBe("无人投票");
  });
});
