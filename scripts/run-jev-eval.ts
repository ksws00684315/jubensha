/**
 * Jev 投票决策离线对照评测。
 *   npx tsx scripts/run-jev-eval.ts                      # 干跑：只校验装配，不发请求
 *   JEV_API_KEY=… npx tsx scripts/run-jev-eval.ts --real --max-calls=20
 *   # 去掉 --max-calls 即跑全量（147 条约几美分），先小样本打通再放全量
 *   … --real --baseline                                   # 同时把现网聊天模型在同 ctx 上重放
 * 依赖 scripts/build-jev-vote-set.ts 先产出 dataset.jsonl。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { askSystemOne, JEV_INPUT_COST_PER_TOKEN_USD, MAX_CHOICE_OPTIONS } from "@/core/jev/client";
import { composeSegments } from "@/core/llm/prompt-segments";
import { chat, extractJson } from "@/core/llm/client";
import type { JevVoteSample } from "@/core/jev/dataset";
import { summarizeVoteOutcomes, type JevVoteOutcome } from "@/core/jev/metrics";

const real = process.argv.includes("--real");
const withBaseline = process.argv.includes("--baseline");
const maxCalls = Number(process.argv.find((a) => a.startsWith("--max-calls="))?.split("=")[1] ?? Number.POSITIVE_INFINITY);
const datasetPath = resolve(process.argv.find((a) => a.startsWith("--dataset="))?.split("=")[1] ?? ".workbuddy/jev-eval/dataset.jsonl");
const out = resolve(process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ?? ".workbuddy/jev-eval/runs/latest.json");

/** tsx 不像 next/prisma 那样自动读 .env；这里只为 JEV_* 三个变量做回退，密钥因此可以留在 .env 里不进命令行。 */
function dotenvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  if (!existsSync(".env")) return undefined;
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

const apiKey = dotenvValue("JEV_API_KEY") ?? "";
const endpoint = { baseUrl: dotenvValue("JEV_BASE_URL") ?? "https://api.typesafe.ai", apiKey, modelId: dotenvValue("JEV_MODEL") ?? "jev-latest" };

function loadSamples(): JevVoteSample[] {
  if (!existsSync(datasetPath)) throw new Error(`语料不存在：${datasetPath}，请先运行 npm run jev:dataset`);
  return readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as JevVoteSample);
}

/**
 * 装配校验：干跑模式唯一的实质断言，也是真实调用前的护栏——
 * criteria 少一个候选就是 Jev 少一个选项，多一个候选就是可能投出不存在的座位。
 */
function validateSample(sample: JevVoteSample): string[] {
  const problems: string[] = [];
  const state = sample.state as Record<string, unknown>;
  for (const key of ["局面与你的角色", "现场记录"]) if (typeof state[key] !== "string" || !state[key]) problems.push(`state.${key} 缺失或为空`);
  if (!Array.isArray(state["补充材料"])) problems.push("state.补充材料 缺失");

  const vote = sample.questions.vote;
  if (vote?.type !== "choice") problems.push("questions.vote 不是 choice");
  else {
    const keys = Object.keys(vote.criteria).sort();
    const want = sample.candidates.map(String).sort();
    if (keys.join(",") !== want.join(",")) problems.push(`criteria 键集与候选集不一致：[${keys}] vs [${want}]`);
    if (keys.length > MAX_CHOICE_OPTIONS) problems.push(`criteria 选项数 ${keys.length} 超上限`);
    if (!vote.instructions) problems.push("vote.instructions 为空");
  }
  const sufficiency = sample.questions.sufficiency;
  if (sufficiency?.type !== "noul") problems.push("questions.sufficiency 不是 noul");

  if (sample.actual && !sample.candidates.includes(sample.actual.target)) problems.push(`历史票投向 ${sample.actual.target} 不在候选集内（重建失真）`);
  if (sample.culpritSeat >= 0 && sample.culpritSeat === sample.seatIndex && !sample.isCulprit) problems.push("culpritSeat 与本座位冲突");
  if (sample.actual && !Number.isInteger(sample.actual.target)) problems.push("历史票 target 非整数");
  return problems;
}

async function main() {
  if (!real) console.log("干跑模式：只校验请求装配与判分链路，不调用任何模型。真实评测请加 --real（需要 JEV_API_KEY），并用 --max-calls 限制调用数。");
  else if (!apiKey) throw new Error("缺少 JEV_API_KEY：--real 需要它；密钥不入库也不写进代码。");

  const samples = loadSamples();
  const invalid = samples.flatMap((s) => validateSample(s).map((p) => `${s.id}: ${p}`));
  if (invalid.length) {
    console.error(`装配校验未通过 ${invalid.length} 项：\n${invalid.slice(0, 10).join("\n")}${invalid.length > 10 ? `\n…另有 ${invalid.length - 10} 项` : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`装配校验：${samples.length} 条样本通过（state 三段齐备、criteria 与候选集一致、票值合法）`);
  const outcomes: JevVoteOutcome[] = [];
  let jevCalls = 0;
  let baselineCalls = 0;

  for (const sample of samples) {
    const base: Omit<JevVoteOutcome, "jevKey" | "jevRejected" | "jevError" | "jevProbability" | "jevConfidence" | "jevSufficiency" | "jevLatencyMs" | "jevInputTokens" | "baselineKey" | "baselineError" | "baselineLatencyMs" | "baselineInputTokens"> = {
      sampleId: sample.id,
      track: sample.track,
      scriptTitle: sample.scriptTitle,
      isCulprit: sample.isCulprit,
      seatKind: sample.seatKind,
      candidates: sample.candidates,
      culpritSeat: sample.culpritSeat,
      actualKey: sample.actual?.target ?? null,
      suspectedFallback: Boolean(sample.actual?.fallbackReason),
    };
    const record: JevVoteOutcome = { ...base, jevKey: null, jevRejected: false, jevError: null, jevProbability: null, jevConfidence: null, jevSufficiency: null, jevLatencyMs: null, jevInputTokens: null, baselineKey: null, baselineError: null, baselineLatencyMs: null, baselineInputTokens: null };

    if (real && jevCalls < maxCalls) {
      jevCalls += 1;
      try {
        const res = await askSystemOne(endpoint, { state: sample.state, questions: sample.questions });
        const vote = res.answers.vote;
        const sufficiency = res.answers.sufficiency;
        record.jevLatencyMs = res.latencyMs;
        record.jevInputTokens = res.usage.inputTokens;
        if (vote?.type === "choice") {
          record.jevRejected = vote.rejected;
          record.jevProbability = vote.probability;
          record.jevConfidence = vote.confidence;
          record.jevKey = vote.key === null ? null : Number(vote.key);
          if (record.jevKey !== null && !sample.candidates.includes(record.jevKey)) record.jevKey = null;
        } else {
          record.jevRejected = true;
        }
        record.jevSufficiency = sufficiency?.type === "noul" ? sufficiency.probability : null;
      } catch (err) {
        record.jevError = err instanceof Error ? err.message : String(err);
      }
    }

    if (withBaseline && real && baselineCalls < maxCalls) {
      baselineCalls += 1;
      const started = Date.now();
      try {
        // 与线上 playerVote 同 ctx、同温度、同指令：分段直接 composeSegments 还原，不另拼一份 prompt
        const res = await chat({
          purpose: sample.isCulprit ? "culprit" : "player",
          messages: composeSegments(sample.segments),
          gameId: null,
          temperature: 0.4,
          taskType: "jev_eval_baseline",
        });
        const parsed = extractJson<{ target?: number }>(res.text);
        const seat = typeof parsed?.target === "number" ? parsed.target - 1 : null;
        record.baselineKey = seat !== null && sample.candidates.includes(seat) ? seat : null;
        record.baselineInputTokens = res.promptTokens;
      } catch (err) {
        record.baselineError = err instanceof Error ? err.message : String(err);
      }
      record.baselineLatencyMs = Date.now() - started;
    }

    outcomes.push(record);
  }

  const summary = summarizeVoteOutcomes(outcomes);
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ version: 1, real, withBaseline, maxCalls: Number.isFinite(maxCalls) ? maxCalls : null, endpoint: { baseUrl: endpoint.baseUrl, modelId: endpoint.modelId }, jevCalls, baselineCalls, summary, outcomes }, null, 2) + "\n");

  console.log(`评测结果已写出：${out}`);
  console.log(`样本 ${summary.counts.eligible} 条（无辜 ${summary.counts.innocent}／真凶 ${summary.counts.culprit}），Jev 实调 ${jevCalls} 次，现网重放 ${baselineCalls} 次`);
  console.log("无辜座位命中真凶：");
  console.log(`  Jev            ${pct(summary.innocent.jev.rate)}（n=${summary.innocent.jev.n}，95%CI ${summary.innocent.jev.ci ? `${pct(summary.innocent.jev.ci[0])}–${pct(summary.innocent.jev.ci[1])}` : "—"}）`);
  console.log(`  现网同 ctx 重放   ${pct(summary.innocent.baselineReplay.rate)}（n=${summary.innocent.baselineReplay.n}）`);
  console.log(`  历史真实票(剔兜底) ${pct(summary.innocent.recordedVotes.rate)}（n=${summary.innocent.recordedVotes.n}）`);
  console.log(`  历史真实票(含兜底) ${pct(summary.innocent.recordedVotesIncludingFallback.rate)}（n=${summary.innocent.recordedVotesIncludingFallback.n}，其中疑似兜底 ${summary.counts.suspectedFallback}）`);
  console.log(`  随机基线         ${pct(summary.innocent.random)}　p=${summary.innocent.pValueVsReplay.toFixed(3)}`);
  console.log("真凶座位（投中真凶=自爆，应低）：", `Jev ${pct(summary.culprit.selfBetrayal.rate)}（n=${summary.culprit.selfBetrayal.n}） vs 历史 ${pct(summary.culprit.selfBetrayalInHistory.rate)}`);
  console.log("时延：", `Jev p50=${summary.latency.jevP50 ?? "—"}ms p95=${summary.latency.jevP95 ?? "—"}ms；重放 p50=${summary.latency.baselineP50 ?? "—"}ms p95=${summary.latency.baselineP95 ?? "—"}ms`);
  console.log("成本：", `Jev 中位输入 ${summary.tokens.jevMedian} tokens ≈ $${(summary.tokens.jevMedian * JEV_INPUT_COST_PER_TOKEN_USD).toFixed(5)}/票（输出免费）；现网重放中位 ${summary.tokens.baselineMedian} tokens`);
  console.log("校准（Jev 概率 vs 实际命中）：");
  for (const c of summary.calibration) console.log(`  ${c.bucket.padEnd(8)} n=${String(c.n).padStart(3)}  平均概率=${c.avgProbability === null ? "—" : c.avgProbability.toFixed(2)}  命中率=${pct(c.hitRate)}  偏差=${c.gap === null ? "—" : c.gap.toFixed(2)}`);
  console.log("弃权模拟（低于阈值退回随机）：");
  for (const a of summary.abstain) console.log(`  t=${a.threshold.toFixed(1)}  覆盖 ${pct(a.coverage)}  覆盖内 ${pct(a.keptAcc)}  组合 ${pct(a.combinedAcc)}`);
  console.log("灰度门槛：", summary.gate.pass ? "全部通过，可进第二期" : "未全部通过，不进第二期");
  for (const c of summary.gate.checks) console.log(`  ${c.pass ? "✅" : "❌"} ${c.name}　${c.detail}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
