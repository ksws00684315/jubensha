/**
 * Jev 投票决策离线语料。
 *
 * 两条轨：
 *  - history：从已完成对局的 vote 事件按 seq 前缀重建决策时刻的玩家视角，
 *    真值来自剧本 truth.culpritId → 座位映射（与引擎 tallyVotes 同一口径）。
 *  - synthetic：复用 eval/snapshots 的 pre_vote 合成场景，只用于回归与校准曲线。
 *
 * 保真度的来源是「复用同一个 buildPlayerContext」：本模块不自己拼提示词，
 * 只把它产出的分段压平成 Jev 的声明式 state。本文件仅离线脚本使用，
 * 线上入口是 ./client.ts（那个模块刻意不 import db，本文件不承诺这一点）。
 */
import { buildPlayerContext } from "@/core/agents/context";
import { initialState } from "@/core/engine/state";
import type { EngineEvent, GameState, SeatInfo } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import type { PromptSegments } from "@/core/llm/types";
import type { JevQuestion } from "./client";

/** Jev 1.13 上下文 64k；输出免费但仍要留 questions 的位子 */
export const JEV_CONTEXT_TOKENS = 64_000;
const JEV_RESERVE_TOKENS = 2_000;
/** 与 llm/client.ts 的 estimateInputTokens 同口径（中文保守估算 3.5 字符≈1 token） */
const CHARS_PER_TOKEN = 3.5;

/**
 * 现网投票里"这一票不是模型决定的"标记。逐条都经过实测核对
 * （2026-09-21，41 局 173 张票）：下面四个字符串在当前语料里一次都没出现——
 * 历史票的兜底大多来自更早的引擎版本；实际命中的只有"reason 与证据双缺"那 25 张（17.5%）。
 * 保留这张表是为了让报告能交代每一票的来源，而不是让评测悄悄丢掉样本。
 */
export const FALLBACK_VOTE_REASONS: Record<string, string> = {
  "依据已公开材料暂作判断，仍需核实行为与动机。": "agent 重试耗尽→随机（index.ts:382）",
  "公开材料不足，暂作判断。": "agent 重试耗尽且无公开线索→随机（index.ts:382）",
  "依据公开材料暂作判断，仍需核实。": "引擎覆盖：无合法公开证据，含超时随机兜底（finale.ts:59 与 :51）",
  "（超时，系统代投；依据公开材料暂作判断）": "真人超时代投（finale.ts:117）",
};
/** 兜底标记未命中现网语料，但双缺形态与旧引擎的超时随机代投一致：记为疑似，交由指标层做敏感性分析 */
export const SUSPECTED_FALLBACK = "疑似兜底：reason 与 evidenceIds 双缺（旧引擎超时随机代投形态）";

export function fallbackLabelOf(vote: { reason: string | null; hasEvidence?: boolean }): string | undefined {
  if (vote.reason === null) return "事件未记 reason 字段（更早引擎版本）";
  const known = FALLBACK_VOTE_REASONS[vote.reason];
  if (known) return known;
  if (vote.reason === "" && !vote.hasEvidence) return SUSPECTED_FALLBACK;
  return undefined;
}

export type JevVoteTrack = "history" | "synthetic";

export interface JevVoteSample {
  id: string;
  track: JevVoteTrack;
  gameId: string | null;
  scriptTitle: string;
  seatIndex: number;
  seatKind: SeatInfo["kind"];
  isCulprit: boolean;
  /** 引擎给定的封闭候选（活跃座位去自己） */
  candidates: number[];
  culpritSeat: number;
  state: Record<string, unknown>;
  /** 线上同构的分段：基线重放走 composeSegments(segments)，保证评测用的 ctx 与线上一致 */
  segments: PromptSegments;
  questions: Record<string, JevQuestion>;
  /** 现网这一票实际投给了谁；synthetic 轨为 null */
  actual: { target: number; reason: string | null; fallbackReason?: string } | null;
  stats: { chars: number; estTokens: number; events: number; logTrimmed: boolean; overflow: boolean };
}

export function culpritSeatOf(script: ScriptDocV2, seats: SeatInfo[]): number {
  return seats.findIndex((s) => s.kind !== "empty" && s.characterId === script.truth.culpritId);
}

export function voteCandidates(seats: SeatInfo[], seatIndex: number): number[] {
  return seats.filter((s) => s.kind !== "empty" && s.index !== seatIndex).map((s) => s.index);
}

/**
 * Choice 的 criteria：键 = 0 基座位索引字符串，与引擎 `state.votes` 的键空间一致
 * （finale.ts:21），Jev 返回的 choice 直接就是座位索引，评测侧不再做一次换算；
 * 1 基座位号只留在标签里，因为玩家看到的发言记录用的是「座位3」。
 * 标签只给名字：公开简介整段塞进来会让单次输入多烧上千 token，而它对"投谁"没有区分度。
 */
export function voteCriteria(script: ScriptDocV2, seats: SeatInfo[], candidates: number[]): Record<string, string> {
  return Object.fromEntries(
    candidates.map((i) => {
      const seat = seats[i];
      const name = script.characters.find((c) => c.id === seat?.characterId)?.name ?? seat?.playerName ?? `玩家${i + 1}`;
      return [String(i), `座位${i + 1} ${name}`];
    })
  );
}

export function voteQuestions(script: ScriptDocV2, seats: SeatInfo[], candidates: number[], isCulprit: boolean): Record<string, JevQuestion> {
  const criteria = voteCriteria(script, seats, candidates);
  return {
    vote: {
      type: "choice",
      instructions: isCulprit
        ? "你要把这一票投给别人。选一个最可能替你承担指认、且不太会被当场追问倒的人——你的目标是脱身，而不是找出真凶。"
        : "你要把这一票投给你认为最可能是真凶的人。只依据现场记录里已经公开的信息判断，证据不足时选疑点最大的。",
      criteria,
    },
    // 与投票同批问一次：Jev 输出免费、按输入计费，同 state 多问一题几乎零边际成本，
    // 而它给出的是"该不该弃权"——正是现网随机兜底想要替代的判断。
    sufficiency: {
      type: "noul",
      instructions: "仅凭现场记录里已经公开的信息，是否已经足以确定真凶是谁？",
      criteria: {
        true: "公开材料能把嫌疑收敛到一个人",
        false: "公开材料仍指向多个人或指向不明",
      },
    },
  };
}

/**
 * 压平：system（公开背景+角色卡+处境）、log（现场记录）、droppable（公开证据登记/可打出的牌/分幕读本）。
 * anchoredHead/anchoredTail 是给聊天模型的任务指令与格式要求（"只输出 JSON…"），
 * 对决策模型无意义且会误导，因此不进 state，改由 questions.instructions 承载等价指令。
 */
export function flattenJevState(segments: PromptSegments): { state: Record<string, unknown>; chars: number; logTrimmed: boolean; overflow: boolean; estTokens: number } {
  const budgetChars = (JEV_CONTEXT_TOKENS - JEV_RESERVE_TOKENS) * CHARS_PER_TOKEN;
  const size = (log: string) => segments.system.length + log.length + segments.droppable.join("\n").length;
  let log = segments.log;
  let logTrimmed = false;
  // 现场记录是唯一可以按"丢最旧"收缩的一层：与聊天路径的分层降级同方向
  while (size(log) > budgetChars && log.length > 4_000) {
    log = `【较早现场记录因模型输入上限已裁剪，仅保留最近部分】\n${log.slice(Math.ceil(log.length * 0.2))}`;
    logTrimmed = true;
  }
  const state = {
    局面与你的角色: segments.system,
    现场记录: log,
    补充材料: segments.droppable,
  };
  const chars = size(log);
  return { state, chars, logTrimmed, overflow: chars > budgetChars, estTokens: Math.ceil(chars / CHARS_PER_TOKEN) };
}

/** 终态 seats 可直接复用：MVP 无死亡淘汰，座位表整局不变（activeSeats 见 engine/state.ts） */
export function seatsFromState(state: GameState): SeatInfo[] {
  return state.seats;
}

/**
 * 重建某张票的决策时刻。传入该座位的 vote 事件，返回当时可见的 ctx。
 * 已知失真（可接受，需在报告里标注）：
 *  - 滚动摘要不用：终态 memory.anchorSeq 通常晚于该票 seq，沿用会把未来信息漏进上下文，
 *    故一律退回逐字现场记录（信息更全，不偏袒任何一方）。
 *  - state.votes 留空：不告诉模型已有多少人投票，避免把投票顺序当成证据。
 */
export function reconstructVoteMoment(args: {
  script: ScriptDocV2;
  finalState: GameState;
  events: EngineEvent[];
  voteEvent: EngineEvent;
}): { state: GameState; events: EngineEvent[]; seatIndex: number; target: number; reason: string | null; hasEvidence: boolean; candidates: number[]; culpritSeat: number } | null {
  const seatIndex = args.voteEvent.fromSeat;
  if (seatIndex === null) return null;
  const seq = BigInt(args.voteEvent.seq);
  const events = args.events.filter((e) => BigInt(e.seq) < seq);
  const seats = seatsFromState(args.finalState);
  if (!seats[seatIndex]) return null;

  const state = initialState(seats);
  state.phase = "VOTE";
  state.round = args.voteEvent.round;
  for (const ev of events) {
    const clueId = ev.content.clueId;
    if (!clueId || (ev.type !== "clue" && ev.type !== "transfer")) continue;
    const holder = ev.visibility.startsWith("seat:") ? Number(ev.visibility.slice(5)) : null;
    if (ev.visibility === "public") {
      state.clueStates[clueId] = { discoveredBy: state.clueStates[clueId]?.discoveredBy ?? holder, isPublic: true };
      continue;
    }
    if (holder === null || Number.isNaN(holder)) continue;
    state.clueStates[clueId] = { discoveredBy: holder, isPublic: state.clueStates[clueId]?.isPublic ?? false };
    const held = (state.heldClues[holder] ??= []);
    if (!held.includes(clueId)) held.push(clueId);
  }

  const raw = args.voteEvent.content.target;
  const target = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(target)) return null;
  return {
    state,
    events,
    seatIndex,
    target,
    reason: typeof args.voteEvent.content.reason === "string" ? args.voteEvent.content.reason : null,
    hasEvidence: Array.isArray(args.voteEvent.content.evidenceIds) && args.voteEvent.content.evidenceIds.length > 0,
    candidates: voteCandidates(seats, seatIndex),
    culpritSeat: culpritSeatOf(args.script, seats),
  };
}

/**
 * 逐字复刻线上投票调用的 requireJson（agents/index.ts:364-365），不 import 它是因为
 * 那串文本内联在 playerVote 里、没有可复用的导出；复刻是为了让"同 ctx 重放现网模型"
 * 这条基线拿到与线上完全相同的指令——少了它聊天模型不知道要输出 JSON，基线会被人为做坏。
 * 代价是这段副本会与线上漂移，改动线上提示词时需同步（评测报告里也标注了这一点）。
 */
export function voteRequireJson(script: ScriptDocV2, state: GameState, candidates: number[], asCulprit: boolean): string {
  // 与 index.ts:362 同序：按 script.clues 顺序取公开线索，线索 ID 列表的顺序也会进 prompt
  const publicEvidenceIds = script.clues.filter((clue) => state.clueStates[clue.id]?.isPublic).map((clue) => clue.id);
  return asCulprit
    ? `请只输出 JSON：{"target":座位号,"reason":"一句话理由","evidenceIds":["公开线索id"]}。可投座位：${candidates.map((n) => n + 1).join("、")}（不能投自己）。把票投给一个能让你脱身的人，理由必须听起来像基于公开讨论。可引用公开线索 ID：${publicEvidenceIds.join("、") || "（暂无）"}。`
    : `请只输出 JSON：{"target":座位号,"reason":"一句话理由","evidenceIds":["公开线索id"]}。可投座位：${candidates.map((n) => n + 1).join("、")}（不能投自己）。你不是全知侦探：只根据公开发言和已公开线索投票，不要把只有你知道的私密情报当成全场共识。可引用公开线索 ID：${publicEvidenceIds.join("、") || "（暂无）"}。证据并不充分时，投疑点较大的人即可，不要表现得像已经知道答案。`;
}

export function buildVoteSample(args: {
  script: ScriptDocV2;
  track: JevVoteTrack;
  gameId: string | null;
  state: GameState;
  events: EngineEvent[];
  seatIndex: number;
  candidates: number[];
  culpritSeat: number;
  actual: { target: number; reason: string | null; hasEvidence?: boolean } | null;
}): JevVoteSample {
  const { script, seatIndex, state, events } = args;
  const seat = state.seats[seatIndex];
  const character = script.characters.find((c) => c.id === seat?.characterId);
  const isCulprit = character?.privateCard.isCulprit ?? false;
  const assembly = buildPlayerContext(script, state, seatIndex, events, { requireJson: voteRequireJson(script, state, args.candidates, isCulprit) });
  const flat = flattenJevState(assembly.segments);
  return {
    id: `${args.track}:${args.gameId ?? script.meta.title}:${seatIndex}`,
    track: args.track,
    gameId: args.gameId,
    scriptTitle: script.meta.title,
    seatIndex,
    seatKind: seat?.kind ?? "empty",
    isCulprit,
    candidates: args.candidates,
    culpritSeat: args.culpritSeat,
    state: flat.state,
    segments: assembly.segments,
    questions: voteQuestions(script, state.seats, args.candidates, isCulprit),
    actual: args.actual ? { target: args.actual.target, reason: args.actual.reason, fallbackReason: fallbackLabelOf(args.actual) } : null,
    stats: { chars: flat.chars, estTokens: flat.estTokens, events: events.length, logTrimmed: flat.logTrimmed, overflow: flat.overflow },
  };
}

/** 合成轨：VOTE 阶段 + 一条公开线索的最小局面，只用于回归与校准曲线，不参与增益判定 */
export function syntheticVoteSamples(script: ScriptDocV2, seatIndexes: number[]): JevVoteSample[] {
  const seats: SeatInfo[] = script.characters.map((character, index) => ({ index, kind: "ai" as const, characterId: character.id, playerName: character.name }));
  const out: JevVoteSample[] = [];
  for (const seatIndex of seatIndexes) {
    const seat = seats[seatIndex];
    if (!seat) continue;
    const state = initialState(seats);
    state.phase = "VOTE";
    state.round = Math.max(1, script.flow.searchRounds);
    const firstClue = script.clues[0];
    if (!firstClue) continue;
    state.clueStates[firstClue.id] = { discoveredBy: seatIndex, isPublic: true };
    const events: EngineEvent[] = [
      {
        seq: "1",
        type: "clue",
        phase: "VOTE",
        round: state.round,
        fromSeat: null,
        toSeat: null,
        visibility: "public",
        content: { clueId: firstClue.id, clueName: firstClue.name, clueContent: firstClue.name, text: `线索「${firstClue.name}」已公开。` },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    out.push(
      buildVoteSample({
        script,
        track: "synthetic",
        gameId: null,
        state,
        events,
        seatIndex,
        candidates: voteCandidates(seats, seatIndex),
        culpritSeat: culpritSeatOf(script, seats),
        actual: null,
      })
    );
  }
  return out;
}
