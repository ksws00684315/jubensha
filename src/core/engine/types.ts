import type { ScriptDocV2 } from "@/core/script/v2/schema";

/** 游戏阶段状态机：LOBBY → READING → SELF_INTRO → [SEARCH → DISCUSSION]×N → VOTE → REVEAL → ENDED */
export type Phase = "LOBBY" | "READING" | "SELF_INTRO" | "SEARCH" | "DISCUSSION" | "VOTE" | "REVEAL" | "ENDED";

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
  /** @deprecated 插话已取消，仅兼容旧存档 */
  interjections: number;
  /** 讨论阶段每人剩余提问次数 */
  questionsLeft: Record<string, number>;
  /** 等待被提问者当众回答 */
  pendingAnswer: { fromSeat: number; toSeat: number; question: string } | null;
}

export interface EngineEvent {
  seq: string;
  type: "phase" | "speech" | "system" | "clue" | "vote" | "private" | "reveal" | "thinking";
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
 * audience 标明流式消息的可见范围："public" 或指定座位号（如私聊仅双方可见）。 */
export type BusMessage =
  | { kind: "event"; event: EngineEvent }
  | { kind: "delta"; seat: number; text: string; audience: "public" | number }
  | { kind: "thinking"; seat: number | "dm" | null; audience: "public" | number }
  | { kind: "end" };

export interface EngineContext {
  gameId: string;
  script: ScriptDocV2;
  state: GameState;
}
