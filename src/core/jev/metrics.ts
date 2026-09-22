/**
 * Jev 投票决策的对照指标。纯函数，输入是评测脚本跑完的逐票结果。
 *
 * 三条口径纪律：
 *  1. 无辜样本与真凶样本分开报——真凶"投中真凶"是自爆而不是正确，混合准确率会双向稀释结论；
 *  2. 现网基线以"同 ctx 重放现网模型"为准，历史真实票只作辅助，且必须把疑似兜底样本单列，
 *     因为随机兜底按 1/(n-1) 命中，混进基线会抬高现网成绩、掩盖（或凭空造出）Jev 的增益；
 *  3. 随机基线 1/(n-1) 始终列出，任何一条命中率都要能跟它对照着看。
 */
import type { JevVoteSample } from "./dataset";

export interface JevVoteOutcome {
  sampleId: string;
  track: JevVoteSample["track"];
  scriptTitle: string;
  isCulprit: boolean;
  seatKind: string;
  candidates: number[];
  culpritSeat: number;
  /** Jev 选中的座位（0 基）；rejected 或缺答时为 null */
  jevKey: number | null;
  jevRejected: boolean;
  jevError: string | null;
  jevProbability: number | null;
  jevConfidence: number | null;
  jevSufficiency: number | null;
  jevLatencyMs: number | null;
  jevInputTokens: number | null;
  /** 同 ctx 重放现网聊天模型的选择 */
  baselineKey: number | null;
  baselineError: string | null;
  baselineLatencyMs: number | null;
  baselineInputTokens: number | null;
  /** 历史真实票（synthetic 轨为 null） */
  actualKey: number | null;
  suspectedFallback: boolean;
}

export interface Rate {
  n: number;
  hits: number;
  rate: number | null;
  /** Wilson 95% 区间 */
  ci: [number, number] | null;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

function rate(n: number, hits: number): Rate {
  if (!n) return { n: 0, hits, rate: null, ci: null };
  const p = hits / n;
  const z = 1.96;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { n, hits, rate: p, ci: [(Math.max(0, c - h) / d), (Math.min(1, c + h) / d)] };
}

/** 两比例 z 检验（双侧，正态近似）；样本太小时返回 1，宁可不判显著 */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number {
  if (n1 < 20 || n2 < 20) return 1;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  const z = (k1 / n1 - k2 / n2) / se;
  // erfc 近似标准正态双侧 p
  const t = Math.abs(z) / Math.SQRT2;
  const tau = 1 / (1 + 0.2316419 * t);
  const d = 0.3989423 * Math.exp((-t * t) / 2);
  const prob = d * tau * (1.0614054 + tau * (-1.4549985 + tau * (2.9718205 + tau * (-3.879864 + tau * 1.968542))));
  return Math.max(0, Math.min(1, prob));
}

function percentile(values: number[], q: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.floor(xs.length * q))];
}

const isLegal = (key: number | null, candidates: number[]) => key !== null && candidates.includes(key);
const isHit = (key: number | null, culpritSeat: number) => key !== null && key === culpritSeat;

/** 可评样本：历史轨、AI 座位、真凶已入座（否则没有"投中"这回事） */
export function eligible(o: JevVoteOutcome): boolean {
  return o.track === "history" && o.seatKind === "ai" && o.culpritSeat >= 0;
}

/** 期望校准误差：按置信度分桶，比较桶内命中率与平均置信度 */
function calibration(buckets: Array<{ label: string; lo: number; hi: number }>, outcomes: JevVoteOutcome[]) {
  return buckets.map((b) => {
    const rows = outcomes.filter((o) => o.jevProbability !== null && o.jevProbability >= b.lo && o.jevProbability < b.hi);
    const hitRows = rows.filter((o) => isHit(o.jevKey, o.culpritSeat));
    const avgProb = rows.length ? rows.reduce((s, o) => s + (o.jevProbability ?? 0), 0) / rows.length : null;
    const observed = rows.length ? hitRows.length / rows.length : null;
    return { bucket: b.label, n: rows.length, avgProbability: avgProb, hitRate: observed, gap: avgProb !== null && observed !== null ? observed - avgProb : null };
  });
}

/** 弃权模拟：Jev 概率低于阈值时退回现网随机兜底，看组合命中率能否不劣于现网 */
function abstainSweep(outcomes: JevVoteOutcome[], randomRate: number, thresholds: number[]) {
  return thresholds.map((t) => {
    const rows = outcomes.filter((o) => o.jevProbability !== null);
    const kept = rows.filter((o) => (o.jevProbability ?? 0) >= t);
    const abstained = rows.length - kept.length;
    const hits = kept.filter((o) => isHit(o.jevKey, o.culpritSeat)).length;
    const coverage = rows.length ? kept.length / rows.length : 0;
    const keptRate = kept.length ? hits / kept.length : 0;
    return { threshold: t, coverage, keptAcc: keptRate, combinedAcc: coverage * keptRate + (1 - coverage) * randomRate, abstained };
  });
}

const CALIBRATION_BUCKETS = [
  { label: "<0.2", lo: 0, hi: 0.2 },
  { label: "0.2-0.4", lo: 0.2, hi: 0.4 },
  { label: "0.4-0.6", lo: 0.4, hi: 0.6 },
  { label: "0.6-0.8", lo: 0.6, hi: 0.8 },
  { label: ">=0.8", lo: 0.8, hi: 1.01 },
];

export function summarizeVoteOutcomes(outcomes: JevVoteOutcome[]) {
  const pool = outcomes.filter(eligible);
  const innocent = pool.filter((o) => !o.isCulprit);
  const culprit = pool.filter((o) => o.isCulprit);

  const jevAnswered = innocent.filter((o) => o.jevKey !== null);
  const jevLegal = innocent.filter((o) => isLegal(o.jevKey, o.candidates));
  const jevHit = jevLegal.filter((o) => isHit(o.jevKey, o.culpritSeat));

  const replay = innocent.filter((o) => o.baselineKey !== null);
  const replayHit = replay.filter((o) => isHit(o.baselineKey, o.culpritSeat));

  const recorded = innocent.filter((o) => o.actualKey !== null && !o.suspectedFallback);
  const recordedHit = recorded.filter((o) => isHit(o.actualKey, o.culpritSeat));
  const recordedAll = innocent.filter((o) => o.actualKey !== null);
  const recordedAllHit = recordedAll.filter((o) => isHit(o.actualKey, o.culpritSeat));

  const randomRates = innocent.map((o) => 1 / Math.max(1, o.candidates.length - 1));
  const randomRate = randomRates.length ? randomRates.reduce((a, b) => a + b, 0) / randomRates.length : null;

  const jevErrors = outcomes.filter((o) => o.jevError).length;
  const culpritSelfBetray = culprit.filter((o) => isHit(o.jevKey, o.culpritSeat));

  const jevP50 = percentile(outcomes.map((o) => o.jevLatencyMs ?? NaN), 0.5);
  const jevP95 = percentile(outcomes.map((o) => o.jevLatencyMs ?? NaN), 0.95);
  const baseP50 = percentile(outcomes.map((o) => o.baselineLatencyMs ?? NaN), 0.5);
  const baseP95 = percentile(outcomes.map((o) => o.baselineLatencyMs ?? NaN), 0.95);
  const jevTokens = percentile(outcomes.map((o) => o.jevInputTokens ?? NaN), 0.5) ?? 0;
  const baseTokens = percentile(outcomes.map((o) => o.baselineInputTokens ?? NaN), 0.5) ?? 0;

  const p = twoProportionP(jevHit.length, jevLegal.length, replayHit.length, replay.length);
  const abstain = abstainSweep(jevAnswered, randomRate ?? 0, [0, 0.3, 0.4, 0.5, 0.6, 0.7]);
  const bestAbstain = abstain.reduce((a, b) => (b.combinedAcc > a.combinedAcc ? b : a), abstain[0]);

  const checks: GateCheck[] = [
    {
      name: "无辜命中率 ≥ 现网重放 +5pp 且 p<0.05",
      pass: jevLegal.length >= 20 && replay.length >= 20 && (jevHit.length / jevLegal.length) - (replayHit.length / replay.length) >= 0.05 && p < 0.05,
      detail: `Jev ${((jevHit.length / Math.max(1, jevLegal.length)) * 100).toFixed(1)}%（n=${jevLegal.length}） vs 重放 ${((replayHit.length / Math.max(1, replay.length)) * 100).toFixed(1)}%（n=${replay.length}），p=${p.toFixed(3)}`,
    },
    {
      name: "合法率 ≥99%",
      pass: jevAnswered.length >= 20 && jevLegal.length / jevAnswered.length >= 0.99,
      detail: `${jevLegal.length}/${jevAnswered.length} = ${((jevLegal.length / Math.max(1, jevAnswered.length)) * 100).toFixed(1)}%${jevAnswered.length < 20 ? `（样本不足 20，比率再高也不判过）` : ""}`,
    },
    {
      name: "p95 时延不劣于现网重放",
      pass: jevP95 !== null && baseP95 !== null && jevP95 <= baseP95,
      detail: `Jev p50=${jevP50}ms p95=${jevP95}ms；重放 p50=${baseP50}ms p95=${baseP95}ms`,
    },
    {
      name: "单票输入成本 ≤ 现网 2 倍",
      pass: baseTokens > 0 && jevTokens <= baseTokens * 2,
      detail: `Jev 中位输入 ${jevTokens} tokens ×$42/M ≈ $${((jevTokens * 42) / 1e6).toFixed(4)}/票；现网重放中位 ${baseTokens} tokens（单价按各自 provider 另行核对）`,
    },
    {
      name: "弃权组合不劣于现网记录组合",
      pass: bestAbstain !== undefined && recordedAll.length > 0 && bestAbstain.combinedAcc >= recordedAllHit.length / recordedAll.length,
      detail: `最优弃权 t=${bestAbstain?.threshold} 组合 ${((bestAbstain?.combinedAcc ?? 0) * 100).toFixed(1)}%（覆盖 ${((bestAbstain?.coverage ?? 0) * 100).toFixed(1)}%） vs 现网记录（含兜底） ${((recordedAllHit.length / Math.max(1, recordedAll.length)) * 100).toFixed(1)}%`,
    },
  ];

  return {
    counts: {
      outcomes: outcomes.length,
      eligible: pool.length,
      innocent: innocent.length,
      culprit: culprit.length,
      jevAnswered: jevAnswered.length,
      jevErrors,
      baselineReplayed: replay.length,
      suspectedFallback: innocent.filter((o) => o.suspectedFallback).length,
    },
    innocent: {
      jev: rate(jevLegal.length, jevHit.length),
      baselineReplay: rate(replay.length, replayHit.length),
      recordedVotes: rate(recorded.length, recordedHit.length),
      recordedVotesIncludingFallback: rate(recordedAll.length, recordedAllHit.length),
      random: randomRate,
      pValueVsReplay: p,
    },
    culprit: {
      n: culprit.length,
      legal: culprit.filter((o) => isLegal(o.jevKey, o.candidates)).length,
      /** 真凶把票投给真凶（也就是自己）＝自爆，越低越像现网真凶的行为 */
      selfBetrayal: rate(culprit.filter((o) => o.jevKey !== null).length, culpritSelfBetray.length),
      selfBetrayalInHistory: rate(culprit.filter((o) => o.actualKey !== null).length, culprit.filter((o) => isHit(o.actualKey, o.culpritSeat)).length),
    },
    latency: { jevP50, jevP95, baselineP50: baseP50, baselineP95: baseP95 },
    tokens: { jevMedian: jevTokens, baselineMedian: baseTokens },
    calibration: calibration(CALIBRATION_BUCKETS, jevAnswered),
    abstain,
    gate: { checks, pass: checks.every((c) => c.pass) },
  };
}
