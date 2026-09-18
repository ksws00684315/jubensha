import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chat } from "@/core/llm/client";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { buildFixedEvaluationBundle } from "@/core/eval/snapshots";
import { scoreEvalResponse } from "@/core/eval/scorer";
import { summarizeEvalRun } from "@/core/eval/runner";
import type { EvalRunRecord } from "@/core/eval/types";

const real = process.argv.includes("--real");
const maxCalls = Number(process.argv.find((value) => value.startsWith("--max-calls="))?.split("=")[1] ?? 20);
const output = resolve(process.argv.find((value) => value.startsWith("--out="))?.split("=")[1] ?? ".workbuddy/eval/runs/latest.json");
const targets = [
  "seeds/sample-5p-cloudlanshan.json",
  "seeds/generated/5p-diqifengheka.json",
];

async function main() {
  if (!real) {
    console.log("干跑模式：仅检查盲读场景，不调用真实模型。需要真实评测时显式加入 --real，并用 --max-calls 限制调用数。");
  }
  const records: EvalRunRecord[] = [];
  for (const file of targets) {
    const script = parseScriptDocV2(JSON.parse(readFileSync(resolve(file), "utf8")));
    for (let seatIndex = 0; seatIndex < script.characters.length && records.length < maxCalls; seatIndex++) {
      const fixed = buildFixedEvaluationBundle(script, seatIndex);
      for (let i = 0; i < fixed.bundle.snapshots.length && records.length < maxCalls; i++) {
        const snapshot = fixed.bundle.snapshots[i];
        const key = fixed.scoringKeys[i];
        const record: EvalRunRecord = { snapshotId: snapshot.id, scriptTitle: script.meta.title, seatIndex, scene: snapshot.scene, score: { snapshotId: snapshot.id, passed: false, issues: [] } };
        if (!real) {
          // 干跑只验证场景和评分键能配对，不把“未调用模型”记作失败。
          record.score = { snapshotId: snapshot.id, passed: false, issues: [] };
        } else {
          try {
            const culprit = script.characters[seatIndex]?.privateCard.isCulprit;
            const result = await chat({ purpose: culprit ? "culprit" : "player", messages: snapshot.messages, gameId: null, temperature: 0.3, maxTokens: 512, taskType: "blind_read_eval" });
            record.response = result.text;
            record.providerName = result.providerName;
            record.modelId = result.modelId;
            record.score = scoreEvalResponse(key, result.text);
          } catch (error) {
            record.error = error instanceof Error ? error.message : String(error);
          }
        }
        records.push(record);
      }
    }
  }
  const summary = summarizeEvalRun(records);
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify({ version: 1, real, generatedAt: new Date().toISOString(), maxCalls, summary, records }, null, 2) + "\n");
  console.log(`盲读评测完成：${output} total=${summary.total} passed=${summary.passed} passRate=${(summary.passRate * 100).toFixed(1)}% leaks=${summary.forbiddenLeaks} errors=${summary.errors}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
