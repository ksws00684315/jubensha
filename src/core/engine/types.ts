import type { ScriptDocV2 } from "@/core/script/v2/schema";

/** 游戏阶段状态机：LOBBY → READING → SELF_INTRO → [SEARCH → DISCUSSION]×N → VOTE → REVEAL → ENDED */
export type Phase = "LOBBY" | "READING" | "SELF_INTRO" | "SEARCH" | "DISCUSSION" | "VOTE" | "REVEAL" | "ENDED";

/**
 * AI 玩家回合前的短行动计划（生成侧校验在 agents/plan.ts）。
 * 定义在 engine/types 而非 agents：它持久化于 GameState.actionPlans，
 * 下沉后 agents→engine 只剩单向 type-only 依赖（批次 I2 解环）。
 */
export interface PlayerActionPlan {
  objectiveId: string | null;
  targetSeat: number | null;
  discloseClueIds: string[];
  holdClueIds: string[];
  nextAction: "state" | "ask" | "defend" | "probe" | "exchange" | "wait";
}

export const PHASE_ORDER: Phase[] = ["LOBBY", "READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"];

export interface SeatInfo {
  index: number;
  kind: "human" | "ai" | "empty";
  characterId: string;
  playerName: string;
}

export interface ClueRuntime {
  discoveredBy: number | null; // 座位索引；null = 未被发现
  isPublic: boolean;
}

export interface VoteRecord {
  target: number;
  reason?: string;
}

/** 复盘答题统计：每题分布与正确项；每人得分（对/总/加权分） */
export interface QuizResult {
  perSeat: Record<string, { correct: number; total: number; score: number }>;
  perQuestion: Array<{ questionId: string; counts: Record<string, number>; correctOptionId: string }>;
}

/** 引擎运行时状态。持久化于 games.state，可由事件流重建。 */
export interface GameState {
  phase: Phase;
  /** 阶段内轮次：SEARCH/DISCUSSION 的第几轮（1-based） */
  round: number;
  seats: SeatInfo[];
  clueStates: Record<string, ClueRuntime>;
  /** 各座位持有的线索（含私藏） */
  heldClues: Record<number, string[]>;
  readySeats: number[];
  /** SELF_INTRO / 轮流发言时已完成的座位 */
  spokenSeats: number[];
  /** 当前轮到谁发言（轮流阶段） */
  turnSeat: number | null;
  votes: Record<string, VoteRecord>; // key = 座位索引字符串
  /** 私聊窗口：当前开放的 from→to 计数 */
  privateChat: Record<string, number>; // key = `${from}-${to}`
  /** 搜证阶段：已选地点待分派 */
  searchChoices: Record<string, string>; // key = 座位, value = 地点
  /** 搜证阶段：待玩家决定公开/私藏的线索（座位 → 线索id），随状态持久化以防重启丢失 */
  pendingPublish: Record<string, string[]>;
  /** 本轮搜证是否已发过牌（防 choose_location/rush 重入再发） */
  searchDealtRound: number;
  /** 投票结果 */
  voteResult: { counts: Record<string, number>; culpritSeat: number; caught: boolean } | null;
  /** 本轮讨论已落地的 mention 插话次数（上限 MAX_INTERJECTIONS_PER_ROUND，进入新讨论轮清零） */
  interjections: number;
  /** 讨论阶段每人剩余提问次数 */
  questionsLeft: Record<string, number>;
  /** 等待被提问者当众回答 */
  pendingAnswer: { fromSeat: number; toSeat: number; question: string; forced?: boolean } | null;
  /** 每轮行动点（座位索引字符串 → 剩余点；技能系统开启时由阶段流转重置） */
  actionPoints?: Record<string, number>;
  /** 已用过的 once 技能（键 `${seat}:${skillId}`，整局有效） */
  usedSkills?: string[];
  /** 复盘答题：座位索引字符串 → 问题id → 选项id（一次性锁定） */
  quizAnswers?: Record<string, Record<string, string>>;
  /** 复盘答题结果（transitionReveal 时计算，随 reveal 事件公布） */
  quizResult?: QuizResult | null;
  /** 由主持/引擎明确解锁的条件秘密；键为 `${seat}:${secretId}`。 */
  unlockedSecrets?: Record<string, boolean>;
  /** 主持保证公开材料的发放记录；用于重启后的幂等与复盘。 */
  hostHandouts?: Record<string, { round: number; reason: string }>;
  /** 主持人手动使用的分级提示记录；键为提示在手册中的索引。 */
  hostHints?: Record<string, { round: number; condition: string; hint: string }>;
  /** 真人限时截止时间（epoch ms，座位索引字符串 → 截止）。仅限时模式下 armHumanTimeout 写入，供前端倒计时展示。 */
  humanDeadlines?: Record<string, number>;
  /**
   * 滚动记忆（分层记忆）：anchorSeq 及之前的「公共」事件已被压缩为 summary。
   * 摘要是全场公共视角，不含任何座位的私密事件；各座位私密情报（持有的线索卡）
   * 始终逐字出现在其上下文尾部的【你持有的线索卡】里，不会因摘要而丢失。
   */
  memory?: { anchorSeq: string; summary: string };
  /** 推荐回复：座位索引字符串 → 该座位轮到发言时后台生成的建议短句（发言/跳过后清除） */
  suggestions?: Record<string, string[]>;
  /** 每座位最近一次正式发言计划；仅作为运行时提示，不能直接改变游戏状态。 */
  actionPlans?: Record<string, PlayerActionPlan>;
}

export interface EngineEvent {
  seq: string;
  type: "phase" | "speech" | "system" | "clue" | "vote" | "private" | "reveal" | "thinking" | "transfer";
  phase: Phase;
  round: number;
  fromSeat: number | null;
  toSeat: number | null;
  visibility: string; // public | seat:<n> | dm
  content: {
    text?: string;
    clueId?: string;
    clueName?: string;
    clueContent?: string;
    location?: string;
    streaming?: boolean;
    reason?: string;
    phase?: Phase;
    round?: number;
    [k: string]: unknown;
  };
  createdAt: string;
}

/** SSE 总线消息：新事件（含补发）或流式 delta。
 * audience 标明流式消息的可见范围："public" 或指定座位号（如私聊仅双方可见）。
 * delta.seat 为 "dm" 表示主持人旁白的流式输出。 */
export type BusMessage =
  | { kind: "event"; event: EngineEvent }
  | { kind: "delta"; seat: number | "dm"; text: string; audience: "public" | number }
  | { kind: "thinking"; seat: number | "dm" | null; audience: "public" | number; generationId?: string }
  | { kind: "end" };

export interface EngineContext {
  gameId: string;
  script: ScriptDocV2;
  state: GameState;
}
