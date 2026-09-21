/**
 * 构造 Jev 投票决策离线语料：
 *   npx tsx scripts/build-jev-vote-set.ts [--limit=50] [--out=.workbuddy/jev-eval/dataset.jsonl]
 * 只需数据库可读，不需要 Jev key。产物供 run-jev-eval.ts 消费。
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { parseScriptForRuntime } from "@/core/script/compat";
import type { EngineEvent, GameState } from "@/core/engine/types";
import { buildVoteSample, reconstructVoteMoment, syntheticVoteSamples, FALLBACK_VOTE_REASONS } from "@/core/jev/dataset";
import type { JevVoteSample } from "@/core/jev/dataset";

const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 50);
const out = resolve(process.argv.find((a) => a.startsWith("--out="))?.split("=")[1] ?? ".workbuddy/jev-eval/dataset.jsonl");
const syntheticOnly = process.argv.includes("--synthetic-only");
/** 合成轨样本剧本：一个样例本 + 一个正式生成本 */
const SYNTH_SCRIPTS = ["seeds/sample-5p-cloudlanshan.json", "seeds/generated/5p-diqifengheka.json"];

async function loadEvents(gameId: string): Promise<EngineEvent[]> {
  const rows = await db.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" } });
  return rows.map((r) => ({
    seq: r.seq.toString(),
    type: r.type as EngineEvent["type"],
    phase: r.phase as EngineEvent["phase"],
    round: r.round,
    fromSeat: r.fromSeat,
    toSeat: r.toSeat,
    visibility: r.visibility,
    content: (r.content ?? {}) as EngineEvent["content"],
    createdAt: r.createdAt.toISOString(),
  }));
}

function sampleStats(samples: JevVoteSample[]) {
  const innocent = samples.filter((s) => !s.isCulprit && s.seatKind === "ai");
  const culprit = samples.filter((s) => s.isCulprit && s.seatKind === "ai");
  const overflow = samples.filter((s) => s.stats.overflow);
  const trimmed = samples.filter((s) => s.stats.logTrimmed);
  const tokens = samples.map((s) => s.stats.estTokens).sort((a, b) => a - b);
  const pct = (q: number) => (tokens.length ? tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * q))] : 0);
  const fallbacks = new Map<string, number>();
  for (const s of samples) {
    if (s.actual?.fallbackReason) fallbacks.set(s.actual.fallbackReason, (fallbacks.get(s.actual.fallbackReason) ?? 0) + 1);
  }
  return {
    total: samples.length,
    aiInnocent: innocent.length,
    aiCulprit: culprit.length,
    humanSeats: samples.filter((s) => s.seatKind === "human").length,
    skippedNoCulpritSeat: samples.filter((s) => s.culpritSeat < 0).length,
    logTrimmed: trimmed.length,
    overflow: overflow.length,
    estTokens: { p50: pct(0.5), p95: pct(0.95), max: pct(1) },
    fallbackReasons: Object.fromEntries(fallbacks),
  };
}

async function main() {
  mkdirSync(resolve(out, ".."), { recursive: true });
  rmSync(out, { force: true });

  const history: JevVoteSample[] = [];
  const games = syntheticOnly ? [] : await db.game.findMany({ where: { status: "ended" }, take: limit, orderBy: { endedAt: "desc" } });
  let gamesWithVotes = 0;
  for (const game of games) {
    if (!game.scriptSnapshot) continue;
    const finalState = game.state as unknown as GameState;
    if (!finalState?.seats?.length) continue;
    const script = parseScriptForRuntime(game.scriptSnapshot);
    const events = await loadEvents(game.id);
    const voteEvents = events.filter((e) => e.type === "vote");
    if (!voteEvents.length) continue;
    gamesWithVotes += 1;
    for (const voteEvent of voteEvents) {
      const seatIndex = voteEvent.fromSeat;
      if (seatIndex === null) continue;
      // 只评 AI 座位：真人票不是现网模型的样本
      if (finalState.seats[seatIndex]?.kind !== "ai") continue;
      const moment = reconstructVoteMoment({ script, finalState, events, voteEvent });
      if (!moment) continue;
      history.push(
        buildVoteSample({
          script,
          track: "history",
          gameId: game.id,
          state: moment.state,
          events: moment.events,
          seatIndex: moment.seatIndex,
          candidates: moment.candidates,
          culpritSeat: moment.culpritSeat,
          actual: { target: moment.target, reason: moment.reason },
        })
      );
    }
  }

  // 合成轨：每部取 1 个无辜座位 + 真凶座位，只服务回归与校准曲线
  const synthetic: JevVoteSample[] = [];
  for (const file of SYNTH_SCRIPTS) {
    const script = parseScriptForRuntime(JSON.parse(readFileSync(resolve(file), "utf8")));
    const culpritIndex = script.characters.findIndex((c) => c.privateCard.isCulprit);
    const innocentIndex = script.characters.findIndex((_, i) => i !== culpritIndex);
    const seatIndexes = [...new Set([culpritIndex, innocentIndex])].filter((i) => i >= 0);
    synthetic.push(...syntheticVoteSamples(script, seatIndexes));
  }

  for (const s of [...history, ...synthetic]) appendFileSync(out, JSON.stringify(s) + "\n");
  const stats = { generatedAt: new Date().toISOString(), games: games.length, gamesWithVotes, history: sampleStats(history), synthetic: sampleStats(synthetic), fallbackCatalog: FALLBACK_VOTE_REASONS };
  writeFileSync(resolve(out, "..", "dataset-stats.json"), JSON.stringify(stats, null, 2) + "\n");
  console.log(`语料已写出：${out}`);
  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect().catch(() => null));
