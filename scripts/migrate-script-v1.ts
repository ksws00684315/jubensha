import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDoc } from "../src/core/script/schema";
import { migrateV1ToV2 } from "../src/core/script/v2/migrate-v1";
import { validateScriptV2 } from "../src/core/script/v2/validate";

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--"));
const outIndex = args.indexOf("--out");
const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
const force = args.includes("--force");

if (!input || (outIndex >= 0 && !output)) {
  console.error("用法: npm run script:migrate -- <v1-file.json> [--out <v2-file.json>] [--force]");
  process.exit(2);
}

try {
  const raw = JSON.parse(readFileSync(input, "utf8"));
  const v1 = parseScriptDoc(raw);
  const result = migrateV1ToV2(v1);
  const issues = validateScriptV2(result.doc);
  const errors = issues.filter((entry) => entry.level === "error");
  for (const warning of result.warnings) console.log(`[migration warning] ${warning.path}: ${warning.message}`);
  for (const issue of issues) console.log(`[${issue.level}] ${issue.path}: ${issue.message}`);
  if (errors.length) {
    console.error(`转换结果仍有 ${errors.length} 个错误，未写入文件。`);
    process.exit(1);
  }
  if (!output) {
    console.log("转换检查通过；未指定 --out，因此未写入文件。");
    process.exit(0);
  }
  const resolvedOutput = path.resolve(output);
  if (existsSync(resolvedOutput) && !force) {
    console.error(`目标文件已存在：${output}。如需覆盖请显式传入 --force。`);
    process.exit(1);
  }
  writeFileSync(resolvedOutput, `${JSON.stringify(result.doc, null, 2)}\n`, "utf8");
  console.log(`已写入 ${output}（${result.warnings.length} 条迁移警告）`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
