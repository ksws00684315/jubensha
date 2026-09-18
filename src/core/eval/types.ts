import type { ChatMessage } from "@/core/llm/types";

/** 固定评估场景。场景只描述玩家此刻合法看到的输入，不携带真相答案。 */
export type EvalScene =
  | "opening"
  | "public_evidence"
  | "timeline_conflict"
  | "conditional_before"
  | "conditional_after"
  | "forced_question"
  | "after_transfer"
  | "pre_vote";

export interface EvalSnapshot {
  version: 1;
  id: string;
  scene: EvalScene;
  scriptHash: string;
  scriptTitle: string;
  seatIndex: number;
  phase: string;
  round: number;
  task: string;
  messages: ChatMessage[];
  visibleClueIds: string[];
  visibleEventSeqs: string[];
  constraints: {
    /** 评分器应检查这些公开材料是否仍能被回答引用。 */
    requiredPublicClueIds?: string[];
    conditionalSecretId?: string;
    questionTargetSeat?: number;
  };
}

/** 仅管理员/离线评分器使用；不要与 snapshots.json 一起发给玩家。 */
export interface EvalScoringKey {
  snapshotId: string;
  mustContain?: string[];
  /** 每组至少命中一个表达，允许模型用自然语言转述公开材料。 */
  mustContainAny?: string[][];
  mustNotContain?: string[];
  notes?: string[];
}

export interface EvalBundle {
  version: 1;
  scriptHash: string;
  scriptTitle: string;
  snapshots: EvalSnapshot[];
}

export interface EvalBundleWithKeys {
  bundle: EvalBundle;
  scoringKeys: EvalScoringKey[];
}

export interface EvalScoreIssue {
  kind: "missing_required" | "forbidden_leak";
  value: string;
}

export interface EvalScore {
  snapshotId: string;
  passed: boolean;
  issues: EvalScoreIssue[];
}

export interface EvalRunRecord {
  snapshotId: string;
  scriptTitle: string;
  seatIndex: number;
  scene: EvalScene;
  response?: string;
  score: EvalScore;
  providerName?: string;
  modelId?: string;
  error?: string;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  passRate: number;
  missingRequired: number;
  forbiddenLeaks: number;
  errors: number;
}
