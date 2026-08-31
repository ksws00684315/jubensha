import { readFileSync } from "node:fs";
import { parseScriptDocV2 } from "../src/core/script/v2/schema";
import { validateScriptV2 } from "../src/core/script/v2/validate";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: npm run script:validate -- <file.json> [more.json ...]");
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const doc = parseScriptDocV2(raw);
    const issues = validateScriptV2(doc);
    const errors = issues.filter((entry) => entry.level === "error");
    const icon = errors.length ? "✗" : issues.length ? "△" : "✓";
    console.log(`${icon} ${file}  error=${errors.length} warning=${issues.length - errors.length}`);
    for (const entry of issues) console.log(`   [${entry.level}] ${entry.path}: ${entry.message}`);
    if (errors.length) failed++;
  } catch (error) {
    failed++;
    console.log(`✗ ${file}  error=1 warning=0`);
    if (error && typeof error === "object" && "issues" in error) {
      for (const issue of (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues) {
        console.log(`   [error] ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
    } else {
      console.log(`   [error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

process.exit(failed ? 1 : 0);
