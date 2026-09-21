import { readFileSync, writeFileSync } from "node:fs";
import { FORMAL_SCRIPT_FILES } from "./formal-script-manifest";
import { ingestScriptDoc } from "../src/core/script/compat";
import { validateScriptV2 } from "../src/core/script/v2/validate";
const results = FORMAL_SCRIPT_FILES.map((file) => {
  try { const { doc } = ingestScriptDoc(JSON.parse(readFileSync(file, "utf8"))); return { file, title: doc.meta.title, issues: validateScriptV2(doc) }; }
  catch (error) { return { file, issues: [{ level: "error", message: String(error) }] }; }
});
writeFileSync(".workbuddy/audit/playtest-2026-09-21/formal-seed-issues.json", JSON.stringify(results, null, 2));
const errors = results.flatMap((r) => r.issues.filter((i) => i.level === "error"));
console.log(JSON.stringify({ scripts: results.length, errors: errors.length, warnings: results.flatMap((r) => r.issues.filter((i) => i.level === "warning")).length, noPrivateWindow: results.filter((r) => r.issues.some((i) => i.message.startsWith("没有有效私藏窗口"))).map((r) => r.title) }));
process.exitCode = errors.length ? 1 : 0;
