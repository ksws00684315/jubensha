import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { buildFixedEvaluationBundle } from "@/core/eval/snapshots";

const input = process.argv.find((value) => value.startsWith("--input="))?.slice("--input=".length) ?? "seeds/sample-5p-cloudlanshan.json";
const out = process.argv.find((value) => value.startsWith("--out="))?.slice("--out=".length) ?? ".workbuddy/eval/sample.json";
const all = process.argv.includes("--all");

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && path.endsWith(".json") && !path.includes("/examples/") && !path.includes("/fixtures/")) files.push(path);
  }
  return files;
}

async function main() {
  if (all) {
    const outputDir = resolve(out.replace(/\.json$/i, ""));
    const inputs = (await filesUnder(resolve("seeds"))).sort();
    const manifest: Array<{ input: string; scriptTitle: string; scriptHash: string; snapshots: number; characters: number; clues: number }> = [];
    for (const file of inputs) {
      const script = parseScriptDocV2(JSON.parse(await readFile(file, "utf8")));
      const { bundle, scoringKeys } = buildFixedEvaluationBundle(script);
      const name = file.replace(/^.*\//, "").replace(/\.json$/i, "");
      await mkdir(outputDir, { recursive: true });
      await writeFile(resolve(outputDir, `${name}.json`), JSON.stringify(bundle, null, 2) + "\n");
      await writeFile(resolve(outputDir, `${name}.scoring-key.json`), JSON.stringify(scoringKeys, null, 2) + "\n");
      manifest.push({ input: file, scriptTitle: bundle.scriptTitle, scriptHash: bundle.scriptHash, snapshots: bundle.snapshots.length, characters: script.characters.length, clues: script.clues.length });
    }
    await writeFile(resolve(outputDir, "manifest.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), scripts: manifest }, null, 2) + "\n");
    console.log(`已生成 ${manifest.length} 本剧本的离线评估快照：${outputDir}`);
    return;
  }
  const script = parseScriptDocV2(JSON.parse(await readFile(resolve(input), "utf8")));
  const { bundle, scoringKeys } = buildFixedEvaluationBundle(script);
  const output = resolve(out);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
  await writeFile(output.replace(/\.json$/i, ".scoring-key.json"), JSON.stringify(scoringKeys, null, 2) + "\n");
  console.log(`已生成 ${bundle.snapshots.length} 个评估场景：${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
