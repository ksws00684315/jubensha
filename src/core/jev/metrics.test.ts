import { describe, expect, it } from "vitest";
import { eligible, summarizeVoteOutcomes, twoProportionP, type JevVoteOutcome } from "./metrics";

const base = (over: Partial<JevVoteOutcome> = {}): JevVoteOutcome => ({
  sampleId: "history:g:1",
  track: "history",
  scriptTitle: "T",
  isCulprit: false,
  seatKind: "ai",
  candidates: [0, 1, 2],
  culpritSeat: 2,
  jevKey: null,
  jevRejected: false,
  jevError: null,
  jevProbability: null,
  jevConfidence: null,
  jevSufficiency: null,
  jevLatencyMs: null,
  jevInputTokens: null,
  baselineKey: null,
  baselineError: null,
  baselineLatencyMs: null,
  baselineInputTokens: null,
  actualKey: null,
  suspectedFallback: false,
  ...over,
});

describe("jev 投票指标口径", () => {
  it("只保留历史轨、AI 座位且真凶入座的样本", () => {
    expect(eligible(base())).toBe(true);
    expect(eligible(base({ track: "synthetic" }))).toBe(false);
    expect(eligible(base({ seatKind: "human" }))).toBe(false);
    expect(eligible(base({ culpritSeat: -1 }))).toBe(false);
  });

  it("无辜与真凶分层报告，真凶的自爆不混进无辜命中率", () => {
    const s = summarizeVoteOutcomes([
      base({ jevKey: 2, jevProbability: 0.9 }),
      base({ jevKey: 0, jevProbability: 0.6 }),
      base({ sampleId: "history:g:9", isCulprit: true, candidates: [0, 1, 3], jevKey: 2, jevProbability: 0.8 }),
    ]);
    expect(s.counts.innocent).toBe(2);
    expect(s.counts.culprit).toBe(1);
    // 无辜：1/2 命中；真凶：投中 culpritSeat=2 属自爆，单独成项
    expect(s.innocent.jev.rate).toBeCloseTo(0.5);
    expect(s.innocent.jev.n).toBe(2);
    expect(s.culprit.selfBetrayal.rate).toBe(1);
  });

  it("非法 choice 与缺答都不计入命中，但会压低合法率", () => {
    const s = summarizeVoteOutcomes([
      base({ jevKey: 7 }),
      base({ jevKey: null, jevRejected: true }),
      base({ jevKey: 2, jevProbability: 0.7 }),
    ]);
    expect(s.counts.jevAnswered).toBe(2);
    expect(s.innocent.jev.n).toBe(1);
    expect(s.innocent.jev.rate).toBe(1);
    // 3 张无辜票里只有 1 张既合法又作答，门槛按 jevLegal/jevAnswered 计
    const legal = s.gate.checks.find((c) => c.name.includes("合法率"));
    expect(legal?.detail).toContain("1/2");
  });

  it("疑似兜底的历史票从主基线剔除，但保留在敏感性口径里", () => {
    const s = summarizeVoteOutcomes([
      base({ actualKey: 2 }),
      base({ actualKey: 0, suspectedFallback: true }),
      base({ actualKey: 2, suspectedFallback: true }),
    ]);
    expect(s.innocent.recordedVotes.n).toBe(1);
    expect(s.innocent.recordedVotes.rate).toBe(1);
    expect(s.innocent.recordedVotesIncludingFallback.n).toBe(3);
    expect(s.innocent.recordedVotesIncludingFallback.rate).toBeCloseTo(0.6667, 3);
    expect(s.counts.suspectedFallback).toBe(2);
  });

  it("校准按概率分桶，命中率能反映高置信桶更准", () => {
    const s = summarizeVoteOutcomes([
      base({ jevKey: 2, jevProbability: 0.9 }),
      base({ jevKey: 1, jevProbability: 0.85 }),
      base({ jevKey: 2, jevProbability: 0.1 }),
    ]);
    const high = s.calibration.find((c) => c.bucket === ">=0.8");
    const low = s.calibration.find((c) => c.bucket === "<0.2");
    expect(high?.hitRate).toBeCloseTo(0.5);
    expect(low?.hitRate).toBe(1);
    expect(low?.gap).toBeCloseTo(0.9);
  });

  it("弃权低于阈值时按随机兜底计入组合命中率", () => {
    const four = { candidates: [0, 1, 2, 3], culpritSeat: 3 };
    const s = summarizeVoteOutcomes([
      base({ ...four, jevKey: 3, jevProbability: 0.9 }),
      base({ ...four, jevKey: 1, jevProbability: 0.2 }),
      base({ ...four, jevKey: 2, jevProbability: 0.2 }),
    ]);
    const never = s.abstain.find((a) => a.threshold === 0);
    const strict = s.abstain.find((a) => a.threshold === 0.3);
    expect(never?.combinedAcc).toBeCloseTo(1 / 3);
    // t=0.3 只留下那条命中的高置信样本，弃权的两条按 1/(n-1)=1/3 的随机命中率计期望
    expect(strict?.coverage).toBeCloseTo(1 / 3);
    expect(strict?.keptAcc).toBe(1);
    expect(strict?.combinedAcc).toBeCloseTo(1 / 3 + (2 / 3) * (1 / 3));
  });

  it("样本量不足时不给显著性结论", () => {
    expect(twoProportionP(10, 10, 1, 10)).toBe(1);
    expect(twoProportionP(20, 40, 2, 40)).toBeLessThan(0.001);
  });

  it("两比例双侧 p 值在显著性边界附近保持正确", () => {
    // 30/50 vs 20/50 的双侧 z 检验 p≈0.0455，必须能通过 p<0.05 门槛。
    expect(twoProportionP(30, 50, 20, 50)).toBeCloseTo(0.0455, 3);
  });

  it("全命中样本的 Wilson 区间上界为 1", () => {
    const s = summarizeVoteOutcomes(Array.from({ length: 16 }, (_, i) => base({ sampleId: `history:g:${i}`, jevKey: 2 })));
    expect(s.innocent.jev.ci?.[0]).toBeCloseTo(0.8064, 3);
    expect(s.innocent.jev.ci?.[1]).toBe(1);
  });
});
