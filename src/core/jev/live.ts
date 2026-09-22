/**
 * ★ 实机 Jev ★：在真实对局里问一次决策模型。两种用法，两个独立开关。
 *
 * - `JEV_FALLBACK=1`（接管；建议常开）：只在现网本来就要 Math.random 的那几步上把 Jev 的选择
 *   真的用上——那条路径是 agent 调用抛错/超时，玩家看不到新增行为，它只会比随机好。
 *   8 局实测触发 2 次、单次两美分量级，都是 provider 审核拒答把一整步决策打成随机。
 * - `JEV_SHADOW=1`（影子；按需开）：每个 AI 座位的投票/选址/公开决定都并行问一次并记账，
 *   结果不变，只出对照。8 局实测 ≈$2/局，其中 4 张影子票占 $1.7，所以不默认开。
 *
 * 两个开关都关或未配 JEV_API_KEY 时本模块整体静默：不调用、不写库、不占预算。
 * 两份额度也各自独立——挂满影子额度不能把接管饿死，反之亦然。
 *
 * 接管点因此全部放在引擎的 catch 分支：agents 层原来"重试耗尽就自己随机一票"的兜底已改为抛错，
 * 于是"模型给了个能用的决定"与"这一票其实是兜底"在引擎里天然可分，影子不会把随机票当成模型决定去对照。
 *
 * 与一期离线评测的差别在于说服力来源：这里 ctx 就是正在跑的那一局（含当轮刚公开的材料），
 * 现网决策也已经发生，于是「Jev 会怎么选 / 它选了是否合法 / 比现网快多少」可以直接算，
 * 不需要重放，也不依赖离线重建出来的状态。
 */
import { db } from "@/lib/db";
import { clueText, narrativeToText } from "@/core/script/compat";
import type { EngineEvent, GameState } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { askSystemOne, JEV_INPUT_COST_PER_TOKEN_USD, type JevEndpoint, type JevQuestion } from "./client";
import { buildVoteSample, voteCandidates } from "./dataset";

export type JevLiveSlot = "vote" | "location" | "publish";

/** shadow=只对照、不改结果；fallback=顶替现网原本随机的兜底 */
export type JevLiveMode = "shadow" | "fallback";

export interface JevLiveConfig {
  endpoint: JevEndpoint;
  slots: Set<JevLiveSlot>;
  enabled: Set<JevLiveMode>;
  /** 两种模式分开计额度：影子挂满也不该把接管饿死 */
  maxCalls: Record<JevLiveMode, number>;
  /** 单次调用超时：两种模式都不能拖慢回合 */
  timeoutMs: number;
}

const ALL_SLOTS: JevLiveSlot[] = ["vote", "location", "publish"];

let cached: { key: string; value: JevLiveConfig | null } | null = null;
const spent = new Map<string, number>();

/** 只在读进程环境时缓存，测试传自有 env 时不缓存。 */
export function liveConfig(env: NodeJS.ProcessEnv = process.env): JevLiveConfig | null {
  const key = [env.JEV_SHADOW, env.JEV_FALLBACK, env.JEV_API_KEY ? "1" : "", env.JEV_BASE_URL, env.JEV_MODEL, env.JEV_LIVE_SLOTS, env.JEV_SHADOW_MAX_CALLS, env.JEV_FALLBACK_MAX_CALLS, env.JEV_LIVE_TIMEOUT_MS].join("|");
  if (env === process.env && cached && cached.key === key) return cached.value;
  const value = computeConfig(env);
  if (env === process.env) cached = { key, value };
  return value;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  return Math.max(1, Number(raw ?? fallback) || fallback);
}

function computeConfig(env: NodeJS.ProcessEnv): JevLiveConfig | null {
  const apiKey = (env.JEV_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const enabled = new Set<JevLiveMode>();
  if (env.JEV_SHADOW === "1") enabled.add("shadow");
  if (env.JEV_FALLBACK === "1") enabled.add("fallback");
  if (!enabled.size) return null;
  const slots = new Set((env.JEV_LIVE_SLOTS ?? ALL_SLOTS.join(",")).split(",").map((s) => s.trim()).filter((s): s is JevLiveSlot => ALL_SLOTS.includes(s as JevLiveSlot)));
  if (!slots.size) return null;
  return {
    endpoint: { baseUrl: (env.JEV_BASE_URL ?? "https://api.typesafe.ai").trim(), apiKey, modelId: (env.JEV_MODEL ?? "jev-latest").trim() },
    slots,
    enabled,
    maxCalls: { shadow: intFromEnv(env.JEV_SHADOW_MAX_CALLS, 24), fallback: intFromEnv(env.JEV_FALLBACK_MAX_CALLS, 8) },
    timeoutMs: Math.max(500, Number(env.JEV_LIVE_TIMEOUT_MS ?? 4000) || 4000),
  };
}

/** 这个模式在这个槽位上还能不能再问一次；用到即扣额度。 */
function takeBudget(cfg: JevLiveConfig, gameId: string, mode: JevLiveMode, slot: JevLiveSlot): boolean {
  if (!cfg.enabled.has(mode) || !cfg.slots.has(slot)) return false;
  const key = `${gameId}|${mode}`;
  const used = spent.get(key) ?? 0;
  if (used >= cfg.maxCalls[mode]) return false;
  spent.set(key, used + 1);
  if (spent.size > 600) {
    for (const stale of [...spent.keys()].slice(0, 200)) spent.delete(stale);
  }
  return true;
}

export function liveCallsUsed(gameId: string, mode: JevLiveMode): number {
  return spent.get(`${gameId}|${mode}`) ?? 0;
}

interface LiveRow {
  gameId: string;
  slot: JevLiveSlot;
  seatIndex: number;
  phase: string;
  round: number;
  jevKey: string | null;
  jevProbability: number | null;
  jevConfidence: number | null;
  actualKey: string | null;
  legal: boolean;
  inputTokens: number;
  stateChars: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

async function writeLiveRow(row: LiveRow, mode: JevLiveMode): Promise<void> {
  const agreed = row.jevKey !== null && row.actualKey !== null ? row.jevKey === row.actualKey : null;
  const usedForAction = mode === "fallback";
  try {
    await db.jevShadowLog.create({
      data: {
        gameId: row.gameId,
        slot: row.slot,
        seatIndex: row.seatIndex,
        phase: row.phase,
        round: row.round,
        jevKey: row.jevKey,
        jevProbability: row.jevProbability,
        jevConfidence: row.jevConfidence,
        actualKey: row.actualKey,
        agreed,
        legal: row.legal,
        usedForAction,
        inputTokens: row.inputTokens,
        stateChars: row.stateChars,
        latencyMs: row.latencyMs,
        ok: row.ok,
        error: row.error?.slice(0, 300) ?? null,
      },
    });
  } catch (err) {
    console.error(`[jev] 记账写入失败 game=${row.gameId} slot=${row.slot} seat=${row.seatIndex}:`, err);
  }
  const costUsd = row.inputTokens * JEV_INPUT_COST_PER_TOKEN_USD;
  totalCostUsd += costUsd;
  totalCalls += 1;
  console.log(`[jev] ${mode} game=${row.gameId.slice(0, 8)} slot=${row.slot} seat=${row.seatIndex} jev=${row.jevKey ?? "-"} actual=${row.actualKey ?? "-"} legal=${row.legal} tok=${row.inputTokens} ms=${row.latencyMs} ≈$${costUsd.toFixed(4)} 累计$${totalCostUsd.toFixed(2)}`);
}

let totalCalls = 0;
let totalCostUsd = 0;

export function liveSpend(): { calls: number; usd: number } {
  return { calls: totalCalls, usd: totalCostUsd };
}

interface AskResult {
  key: string | null;
  probability: number | null;
  confidence: number | null;
  inputTokens: number;
  latencyMs: number;
  error?: string;
}

/** 一次调用 + 一条记账，永不抛错；返回 null 表示这次问不到（调用方按原逻辑兜底）。 */
async function askAndRecord(args: {
  cfg: JevLiveConfig;
  /** 影子＝只对照不改结果；接管＝这一答就是本步的决定 */
  mode: JevLiveMode;
  gameId: string;
  slot: JevLiveSlot;
  seatIndex: number;
  phase: string;
  round: number;
  state: Record<string, unknown>;
  stateChars: number;
  questions: Record<string, JevQuestion>;
  questionId: string;
  /** 该题在规则上允许的键；不在其中即判为不合法 */
  legalKeys: Set<string> | null;
  actualKey: string | null;
}): Promise<AskResult | null> {
  const { cfg, slot, mode } = args;
  if (!takeBudget(cfg, args.gameId, mode, slot)) return null;
  try {
    const res = await askSystemOne(cfg.endpoint, { state: args.state, questions: args.questions }, { timeoutMs: cfg.timeoutMs });
    const answer = res.answers[args.questionId];
    const jevKey = answer?.type === "choice" ? answer.key : answer?.type === "noul" ? (answer.probability === null ? null : answer.probability >= 0.5 ? "true" : "false") : null;
    const legal = jevKey !== null && (args.legalKeys === null || args.legalKeys.has(jevKey));
    const out: AskResult = {
      key: legal ? jevKey : null,
      probability: answer?.type === "score" ? null : answer?.probability ?? null,
      confidence: answer?.confidence ?? null,
      inputTokens: res.usage.inputTokens,
      latencyMs: res.latencyMs,
    };
    await writeLiveRow({
      gameId: args.gameId,
      slot,
      seatIndex: args.seatIndex,
      phase: args.phase,
      round: args.round,
      jevKey,
      jevProbability: out.probability,
      jevConfidence: out.confidence,
      actualKey: args.actualKey,
      legal,
      inputTokens: out.inputTokens,
      stateChars: args.stateChars,
      latencyMs: out.latencyMs,
      ok: true,
    }, mode);
    return out;
  } catch (err) {
    await writeLiveRow({
      gameId: args.gameId,
      slot,
      seatIndex: args.seatIndex,
      phase: args.phase,
      round: args.round,
      jevKey: null,
      jevProbability: null,
      jevConfidence: null,
      actualKey: args.actualKey,
      legal: false,
      inputTokens: 0,
      stateChars: args.stateChars,
      latencyMs: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, mode);
    return null;
  }
}

interface SeatCtx {
  script: ScriptDocV2;
  state: GameState;
  events: EngineEvent[];
  gameId: string;
}

/** 与该座位线上投票同构的 state（含其私密卡），复用离线评测的装配口径 */
function seatVoteState(ctx: SeatCtx, seatIndex: number, candidates: number[]) {
  const sample = buildVoteSample({
    script: ctx.script,
    track: "history",
    gameId: ctx.gameId,
    state: ctx.state,
    events: ctx.events,
    seatIndex,
    candidates,
    culpritSeat: -1,
    actual: null,
  });
  // 只问 vote：离线那批同问的 sufficiency 已被证实答的不是"该不该弃权"（见评测报告），
  // 影子层不要再为它付输入 token。
  return { state: sample.state, questions: { vote: sample.questions.vote }, chars: sample.stats.chars };
}

/**
 * 问一次「这个座位这一票投谁」。影子与接管共用：
 * 影子在票已记下后调用（actualKey=实际票），接管在随机代投前调用（actualKey=null）。
 */
async function askSeatVote(ctx: SeatCtx, seatIndex: number, actualTarget: number | null, mode: JevLiveMode): Promise<AskResult | null> {
  const cfg = liveConfig();
  if (!cfg) return null;
  const candidates = voteCandidates(ctx.state.seats, seatIndex);
  if (!candidates.length) return null;
  const built = seatVoteState(ctx, seatIndex, candidates);
  return askAndRecord({
    cfg,
    mode,
    gameId: ctx.gameId,
    slot: "vote",
    seatIndex,
    phase: ctx.state.phase,
    round: ctx.state.round,
    state: built.state,
    stateChars: built.chars,
    questions: built.questions,
    questionId: "vote",
    legalKeys: new Set(candidates.map((c) => String(c))),
    actualKey: actualTarget === null ? null : String(actualTarget),
  });
}

/** 影子：记下「Jev 会怎么投」，与这一票的实际去向对照 */
export async function shadowVote(ctx: SeatCtx, seatIndex: number, actualTarget: number): Promise<void> {
  await askSeatVote(ctx, seatIndex, actualTarget, "shadow");
}

/** 接管：只给现网本来就要随机代投的路径用；问不到就返回 null，由调用方按原样随机 */
export async function jevVoteFallback(ctx: SeatCtx, seatIndex: number): Promise<{ target: number; probability: number | null } | null> {
  const res = await askSeatVote(ctx, seatIndex, null, "fallback");
  if (!res?.key) return null;
  const target = Number(res.key);
  if (!Number.isInteger(target) || !voteCandidates(ctx.state.seats, seatIndex).includes(target)) return null;
  return { target, probability: res.probability };
}

/** 搜证选址/公开决定的紧凑 state：这两步要判断的信息本来就窄，不需要整段现场记录 */
function compactState(lines: Record<string, string>): { state: Record<string, unknown>; chars: number } {
  const state: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(lines)) state[k] = v;
  const chars = Object.values(lines).reduce((n, v) => n + v.length, 0);
  return { state, chars };
}

async function askSeatBoolOrChoice(args: {
  slot: "location" | "publish";
  mode: JevLiveMode;
  ctx: SeatCtx;
  seatIndex: number;
  lines: Record<string, string>;
  question: JevQuestion;
  legalKeys: Set<string> | null;
  actualKey: string | null;
}): Promise<AskResult | null> {
  const cfg = liveConfig();
  if (!cfg) return null;
  const built = compactState(args.lines);
  return askAndRecord({
    cfg,
    mode: args.mode,
    gameId: args.ctx.gameId,
    slot: args.slot,
    seatIndex: args.seatIndex,
    phase: args.ctx.state.phase,
    round: args.ctx.state.round,
    state: built.state,
    stateChars: built.chars,
    questions: { answer: args.question },
    questionId: "answer",
    legalKeys: args.legalKeys,
    actualKey: args.actualKey,
  });
}

function seatGoal(ctx: SeatCtx, seatIndex: number): string {
  const seat = ctx.state.seats[seatIndex];
  const character = ctx.script.characters.find((c) => c.id === seat?.characterId);
  const objectives = (character?.privateCard.objectives ?? []).map((o) => `${o.title}：${narrativeToText(o.content)}`).slice(0, 3);
  const publicClues = ctx.script.clues.filter((clue) => ctx.state.clueStates[clue.id]?.isPublic).map((clue) => clue.name);
  return [
    `你的处境：${character?.name ?? `座位${seatIndex + 1}`}。你的目标：${objectives.join("；") || "推进调查"}`,
    `已经公开的材料：${publicClues.join("、") || "（暂无）"}`,
  ].join("\n");
}

/** 影子：这一轮的搜证选址 */
export async function shadowLocation(ctx: SeatCtx, seatIndex: number, locations: string[], actualLocation: string | null): Promise<void> {
  await askLocation(ctx, seatIndex, locations, actualLocation, "shadow");
}

async function askLocation(ctx: SeatCtx, seatIndex: number, locations: string[], actualLocation: string | null, mode: JevLiveMode): Promise<string | null> {
  if (!locations.length) return null;
  const criteria = Object.fromEntries(locations.map((name, i) => [String(i), name]));
  const res = await askSeatBoolOrChoice({
    slot: "location",
    mode,
    ctx,
    seatIndex,
    lines: {
      situation: seatGoal(ctx, seatIndex),
      question: `你要去哪个地点搜证？`,
      options: locations.map((n, i) => `${i}:${n}`).join(" "),
    },
    question: {
      type: "choice",
      instructions: mode === "fallback" ? "上一轮你没能给出可选的地点。从可去地点里选出最该去的一个。" : "从可去地点里选出最该去的一个。",
      criteria,
    },
    legalKeys: new Set(Object.keys(criteria)),
    actualKey: actualLocation === null ? null : String(locations.indexOf(actualLocation)),
  });
  if (!res?.key) return null;
  return locations[Number(res.key)] ?? null;
}

/** 接管：现网选址重试耗尽/超时后才用；问不到返回 null，由调用方按原样随机 */
export async function jevLocationFallback(ctx: SeatCtx, seatIndex: number, locations: string[]): Promise<string | null> {
  return askLocation(ctx, seatIndex, locations, null, "fallback");
}

/**
 * 影子：拿到线索后公开还是私藏。
 * 这一步没有接管入口——现网的兜底是「私藏」而不是随机，且 8 局读数里 Jev 的偏好
 * 全贴在 p≈0.5 上单向倾向捂线索，交给它只会让场上少料。
 */
export async function shadowPublish(ctx: SeatCtx, seatIndex: number, clueId: string, actualPublish: boolean): Promise<void> {
  const clue = ctx.script.clues.find((c) => c.id === clueId);
  if (!clue) return;
  await askSeatBoolOrChoice({
    slot: "publish",
    mode: "shadow",
    ctx,
    seatIndex,
    lines: {
      situation: seatGoal(ctx, seatIndex),
      clue: `你手上有线索卡【${clue.name}】：${clueText(clue).slice(0, 600)}`,
    },
    question: {
      type: "noul",
      instructions: "现在把它当众公开，对你更有利吗？",
      criteria: { true: "公开能推进你的目标", false: "留着更有利，或还不到时候" },
    },
    legalKeys: null,
    actualKey: String(actualPublish),
  });
}
