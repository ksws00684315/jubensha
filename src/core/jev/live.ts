/**
 * ★ 实机影子 ★：在真实对局里并行问一次 Jev，只记账、不改变结果。
 *
 * 与一期离线评测的差别在于说服力来源：这里 ctx 就是正在跑的那一局（含当轮刚公开的材料），
 * 现网决策也已经发生，于是「Jev 会怎么选 / 它选了是否合法 / 比现网快多少」可以直接算，
 * 不需要重放，也不依赖离线重建出来的状态。
 *
 * 唯一的例外是 `jev* 接管`：现网那条路径本来就要 Math.random 代投（agent 调用失败或重试耗尽），
 * 此时把 Jev 的选择真的用上——它只会比随机票好，玩家看不到新增行为。
 * 接管点因此全部放在引擎的 catch 分支：agents 层原来"重试耗尽就自己随机一票"的兜底已改为抛错，
 * 于是"模型给了个能用的决定"与"这一票其实是兜底"在引擎里天然可分，影子不会把随机票当成模型决定去对照。
 *
 * 未配 JEV_API_KEY、或 JEV_SHADOW 不为 1 时，本模块整体静默：不调用、不写库、不占预算。
 */
import { db } from "@/lib/db";
import { clueText, narrativeToText } from "@/core/script/compat";
import type { EngineEvent, GameState } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { askSystemOne, JEV_INPUT_COST_PER_TOKEN_USD, type JevEndpoint, type JevQuestion } from "./client";
import { buildVoteSample, voteCandidates } from "./dataset";

export type JevShadowSlot = "vote" | "location" | "publish";

export interface JevShadowConfig {
  endpoint: JevEndpoint;
  slots: Set<JevShadowSlot>;
  /** 每局最多问几次（含被真正用上的接管调用）；到顶即回落现网原有兜底。
   * 投票只在终局发生，额度得留够，否则前面的选址/公开先把预算吃光。 */
  maxCallsPerGame: number;
  /** 单次调用超时：影子不能拖慢回合 */
  timeoutMs: number;
}

const ALL_SLOTS: JevShadowSlot[] = ["vote", "location", "publish"];

let cached: { key: string; value: JevShadowConfig | null } | null = null;
const spentByGame = new Map<string, number>();

/** 只在读进程环境时缓存，测试传自有 env 时不缓存。 */
export function shadowConfig(env: NodeJS.ProcessEnv = process.env): JevShadowConfig | null {
  const key = `${env.JEV_SHADOW}|${env.JEV_API_KEY ? "1" : ""}|${env.JEV_BASE_URL}|${env.JEV_MODEL}|${env.JEV_SHADOW_SLOTS}|${env.JEV_SHADOW_MAX_CALLS}|${env.JEV_SHADOW_TIMEOUT_MS}`;
  if (env === process.env && cached && cached.key === key) return cached.value;
  const value = computeConfig(env);
  if (env === process.env) cached = { key, value };
  return value;
}

function computeConfig(env: NodeJS.ProcessEnv): JevShadowConfig | null {
  if (env.JEV_SHADOW !== "1") return null;
  const apiKey = (env.JEV_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const slots = new Set((env.JEV_SHADOW_SLOTS ?? "vote").split(",").map((s) => s.trim()).filter((s): s is JevShadowSlot => ALL_SLOTS.includes(s as JevShadowSlot)));
  if (!slots.size) return null;
  return {
    endpoint: { baseUrl: (env.JEV_BASE_URL ?? "https://api.typesafe.ai").trim(), apiKey, modelId: (env.JEV_MODEL ?? "jev-latest").trim() },
    slots,
    maxCallsPerGame: Math.max(1, Number(env.JEV_SHADOW_MAX_CALLS ?? 24) || 24),
    timeoutMs: Math.max(500, Number(env.JEV_SHADOW_TIMEOUT_MS ?? 4000) || 4000),
  };
}

/** 记账本局是否还有额度；用到即扣，影子与接管共用同一份额度。 */
function takeBudget(gameId: string, cap: number): boolean {
  const used = spentByGame.get(gameId) ?? 0;
  if (used >= cap) return false;
  spentByGame.set(gameId, used + 1);
  if (spentByGame.size > 300) {
    for (const key of [...spentByGame.keys()].slice(0, 100)) spentByGame.delete(key);
  }
  return true;
}

export function shadowCallsUsed(gameId: string): number {
  return spentByGame.get(gameId) ?? 0;
}

interface ShadowRow {
  gameId: string;
  slot: JevShadowSlot;
  seatIndex: number;
  phase: string;
  round: number;
  jevKey: string | null;
  jevProbability: number | null;
  jevConfidence: number | null;
  actualKey: string | null;
  legal: boolean;
  usedForAction: boolean;
  inputTokens: number;
  stateChars: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

async function writeShadowRow(row: ShadowRow): Promise<void> {
  const agreed = row.jevKey !== null && row.actualKey !== null ? row.jevKey === row.actualKey : null;
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
        usedForAction: row.usedForAction,
        inputTokens: row.inputTokens,
        stateChars: row.stateChars,
        latencyMs: row.latencyMs,
        ok: row.ok,
        error: row.error?.slice(0, 300) ?? null,
      },
    });
  } catch (err) {
    console.error(`[jev] 影子记账写入失败 game=${row.gameId} slot=${row.slot} seat=${row.seatIndex}:`, err);
  }
  const costUsd = row.inputTokens * JEV_INPUT_COST_PER_TOKEN_USD;
  totalCostUsd += costUsd;
  totalCalls += 1;
  console.log(`[jev] shadow game=${row.gameId.slice(0, 8)} slot=${row.slot} seat=${row.seatIndex} jev=${row.jevKey ?? "-"} actual=${row.actualKey ?? "-"} legal=${row.legal} used=${row.usedForAction} tok=${row.inputTokens} ms=${row.latencyMs} ≈$${costUsd.toFixed(4)} 累计$${totalCostUsd.toFixed(2)}`);
}

let totalCalls = 0;
let totalCostUsd = 0;

export function shadowSpend(): { calls: number; usd: number } {
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
  cfg: JevShadowConfig;
  gameId: string;
  slot: JevShadowSlot;
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
  usedForAction: boolean;
}): Promise<AskResult | null> {
  const { cfg, slot } = args;
  if (!cfg.slots.has(slot) || !takeBudget(args.gameId, cfg.maxCallsPerGame)) return null;
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
    await writeShadowRow({
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
      usedForAction: args.usedForAction,
      inputTokens: out.inputTokens,
      stateChars: args.stateChars,
      latencyMs: out.latencyMs,
      ok: true,
    });
    return out;
  } catch (err) {
    await writeShadowRow({
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
      usedForAction: args.usedForAction,
      inputTokens: 0,
      stateChars: args.stateChars,
      latencyMs: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
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
async function askSeatVote(ctx: SeatCtx, seatIndex: number, actualTarget: number | null, usedForAction: boolean): Promise<AskResult | null> {
  const cfg = shadowConfig();
  if (!cfg) return null;
  const candidates = voteCandidates(ctx.state.seats, seatIndex);
  if (!candidates.length) return null;
  const built = seatVoteState(ctx, seatIndex, candidates);
  return askAndRecord({
    cfg,
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
    usedForAction,
  });
}

/** 影子：记下「Jev 会怎么投」，与这一票的实际去向对照 */
export async function shadowVote(ctx: SeatCtx, seatIndex: number, actualTarget: number): Promise<void> {
  await askSeatVote(ctx, seatIndex, actualTarget, false);
}

/** 接管：只给现网本来就要随机代投的路径用；问不到就返回 null，由调用方按原样随机 */
export async function jevVoteFallback(ctx: SeatCtx, seatIndex: number): Promise<{ target: number; probability: number | null } | null> {
  const res = await askSeatVote(ctx, seatIndex, null, true);
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
  ctx: SeatCtx;
  seatIndex: number;
  lines: Record<string, string>;
  question: JevQuestion;
  legalKeys: Set<string> | null;
  actualKey: string | null;
  usedForAction: boolean;
}): Promise<AskResult | null> {
  const cfg = shadowConfig();
  if (!cfg) return null;
  const built = compactState(args.lines);
  return askAndRecord({
    cfg,
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
    usedForAction: args.usedForAction,
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
  await askLocation(ctx, seatIndex, locations, actualLocation, false);
}

async function askLocation(ctx: SeatCtx, seatIndex: number, locations: string[], actualLocation: string | null, usedForAction: boolean): Promise<string | null> {
  if (!locations.length) return null;
  const criteria = Object.fromEntries(locations.map((name, i) => [String(i), name]));
  const res = await askSeatBoolOrChoice({
    slot: "location",
    ctx,
    seatIndex,
    lines: {
      situation: seatGoal(ctx, seatIndex),
      question: `你要去哪个地点搜证？`,
      options: locations.map((n, i) => `${i}:${n}`).join(" "),
    },
    question: {
      type: "choice",
      instructions: usedForAction ? "上一轮你没能给出可选的地点。从可去地点里选出最该去的一个。" : "从可去地点里选出最该去的一个。",
      criteria,
    },
    legalKeys: new Set(Object.keys(criteria)),
    actualKey: actualLocation === null ? null : String(locations.indexOf(actualLocation)),
    usedForAction,
  });
  if (!res?.key) return null;
  return locations[Number(res.key)] ?? null;
}

/** 接管：现网选址重试耗尽/超时后才用；问不到返回 null，由调用方按原样随机 */
export async function jevLocationFallback(ctx: SeatCtx, seatIndex: number, locations: string[]): Promise<string | null> {
  return askLocation(ctx, seatIndex, locations, null, true);
}

/** 影子：拿到线索后公开还是私藏 */
export async function shadowPublish(ctx: SeatCtx, seatIndex: number, clueId: string, actualPublish: boolean): Promise<void> {
  const clue = ctx.script.clues.find((c) => c.id === clueId);
  if (!clue) return;
  await askSeatBoolOrChoice({
    slot: "publish",
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
    usedForAction: false,
  });
}
