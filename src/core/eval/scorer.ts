import type { EvalScore, EvalScoringKey } from "./types";

/** 离线确定性评分；不调用模型，也不需要真相之外的运行时状态。 */
export function scoreEvalResponse(key: EvalScoringKey, response: string): EvalScore {
  const text = response.trim();
  const issues: EvalScore["issues"] = [];
  for (const value of key.mustContain ?? []) {
    if (value && !text.includes(value)) issues.push({ kind: "missing_required", value });
  }
  for (const alternatives of key.mustContainAny ?? []) {
    const values = alternatives.filter(Boolean);
    if (values.length > 0 && !values.some((value) => text.includes(value))) {
      issues.push({ kind: "missing_required", value: values.join(" / ") });
    }
  }
  for (const value of key.mustNotContain ?? []) {
    if (value && text.includes(value)) issues.push({ kind: "forbidden_leak", value });
  }
  return { snapshotId: key.snapshotId, passed: issues.length === 0, issues };
}
