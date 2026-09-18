import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { authorDesignPackageSchema } from "@/core/script/design";
import { auditScriptPlayability } from "@/core/script/playability";

const targets = [
  ["seeds/sample-5p-cloudlanshan.json", "docs/design-packages/cloudlanshan.json", "docs/design-packages/cloudlanshan-playability.json"],
  ["seeds/generated/5p-diqifengheka.json", "docs/design-packages/diqifengheka.json", "docs/design-packages/diqifengheka-playability.json"],
] as const;
mkdirSync(resolve("docs/design-packages"), { recursive: true });
let errors = 0;
for (const [scriptFile, designFile, outputFile] of targets) {
  const doc = parseScriptDocV2(JSON.parse(readFileSync(resolve(scriptFile), "utf8")));
  const design = authorDesignPackageSchema.parse(JSON.parse(readFileSync(resolve(designFile), "utf8")));
  const issues = auditScriptPlayability(doc, design);
  writeFileSync(resolve(outputFile), JSON.stringify({ script: doc.meta.title, generatedAt: new Date().toISOString(), issues }, null, 2) + "\n");
  console.log(`${issues.some((i) => i.level === "error") ? "✗" : "✓"} ${doc.meta.title} errors=${issues.filter((i) => i.level === "error").length} warnings=${issues.filter((i) => i.level === "warning").length}`);
  errors += issues.filter((i) => i.level === "error").length;
}
process.exitCode = errors ? 1 : 0;
