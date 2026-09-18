import type { EvalRunRecord, EvalRunSummary } from "./types";

export function summarizeEvalRun(records: EvalRunRecord[]): EvalRunSummary {
  const passed = records.filter((record) => record.score.passed).length;
  return {
    total: records.length,
    passed,
    passRate: records.length ? passed / records.length : 0,
    missingRequired: records.reduce((sum, record) => sum + record.score.issues.filter((issue) => issue.kind === "missing_required").length, 0),
    forbiddenLeaks: records.reduce((sum, record) => sum + record.score.issues.filter((issue) => issue.kind === "forbidden_leak").length, 0),
    errors: records.filter((record) => Boolean(record.error)).length,
  };
}
