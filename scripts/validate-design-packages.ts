import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { authorDesignPackageSchema, validateAuthorDesignPackage } from "@/core/script/design";
import { parseScriptDocV2 } from "@/core/script/v2/schema";

const pairs = process.argv.slice(2);
const defaults = [
  ["seeds/sample-5p-cloudlanshan.json", "docs/design-packages/cloudlanshan.json"],
  ["seeds/generated/5p-diqifengheka.json", "docs/design-packages/diqifengheka.json"],
];
const targets = pairs.length ? pairs.map((value) => value.split("=") as [string, string]) : defaults;
let errors = 0;
for (const [scriptFile, packageFile] of targets) {
  try {
    const doc = parseScriptDocV2(JSON.parse(readFileSync(resolve(scriptFile), "utf8")));
    const pkg = authorDesignPackageSchema.parse(JSON.parse(readFileSync(resolve(packageFile), "utf8")));
    const issues = validateAuthorDesignPackage(pkg, doc);
    for (const issue of issues) console.log(`${issue.level} ${scriptFile} ${issue.path}: ${issue.message}`);
    errors += issues.filter((issue) => issue.level === "error").length;
    if (!issues.some((issue) => issue.level === "error")) console.log(`✓ ${doc.meta.title}`);
  } catch (error) {
    errors++;
    console.error(`error ${scriptFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exitCode = errors ? 1 : 0;
