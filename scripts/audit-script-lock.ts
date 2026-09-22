import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ingestScriptDoc } from "@/core/script/compat";
import { computeLockMetric, type LockMetricReport } from "@/core/script/lock-metric";

/**
 * 语料级"几卡锁凶"基线：seeds/*.json + seeds/generated/*.json → 表格 + docs/design-packages/lock-metric.json
 * 只读；退出码固定 0（本步骤只立指标，门禁在 validate 层）。
 */
const files = [...readdirSync(resolve("seeds")).filter((f) => f.endsWith(".json")).map((f) => join("seeds", f)),
  ...readdirSync(resolve("seeds/generated")).filter((f) => f.endsWith(".json")).map((f) => join("seeds/generated", f))];

const reports: Array<LockMetricReport & { file: string }> = [];
const failed: string[] = [];
for (const file of files) {
  try {
    reports.push({ ...computeLockMetric(ingestScriptDoc(JSON.parse(readFileSync(file, "utf8"))).doc), file });
  } catch (err) {
    failed.push(`${file}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}
const lockCount = (r: LockMetricReport) => r.rounds[0]?.lockInTable?.count ?? 99;
reports.sort((a, b) => lockCount(a) - lockCount(b) || a.title.localeCompare(b.title, "zh"));

const cell = (s: string | number, w: number) => {
  const text = String(s);
  const wide = [...text].reduce((n, ch) => n + (/[一-龥０-９－（）：、，。]/.test(ch) ? 2 : 1), 0);
  return `${text}${" ".repeat(Math.max(1, w - wide))}`;
};
const fmt = (r: LockMetricReport) => {
  const r1 = r.rounds[0];
  const lock = r1?.lockInTable ? `${r1.lockInTable.count}卡` : "≥4卡";
  const shared = r1?.lockInShared ? `共见${r1.lockInShared.count}卡` : "共见—";
  return [cell(r.title, 26), cell(r.clueCount, 5), cell(r.namingClueIds.length, 5), cell(r.accusingClueIds.length, 5), cell(lock, 6), cell(shared, 8), cell(r.verdictClueIds.length, 5), cell(r.blankedWitnesses.length, 5)].join(" ");
};

console.log(cell("剧本", 26) + [cell("卡", 5), cell("点名", 5), cell("指认", 5), cell("R1锁", 6), cell("R1共见", 8), cell("判词", 5), cell("抹名", 5)].join(" "));
for (const r of reports) console.log(fmt(r));

const countWith = (fn: (r: LockMetricReport) => boolean) => reports.filter((r) => fn(r)).length;
const single = reports.filter((r) => r.rounds.some((x) => x.singleCardClueIds.length > 0));
console.log(`\n本数=${reports.length} 解析失败=${failed.length}`);
console.log(`R1 即单卡锁凶：${countWith((r) => (r.rounds[0]?.lockInTable?.count ?? 9) === 1)} 本；任意轮单卡锁凶：${single.length} 本（命中卡 ${[...new Set(single.flatMap((r) => r.rounds.flatMap((x) => x.singleCardClueIds)))].length} 张）`);
console.log(`R1 两卡内锁凶：${countWith((r) => (r.rounds[0]?.lockInTable?.count ?? 9) <= 2)} 本；R1 共见材料即锁凶：${countWith((r) => (r.rounds[0]?.lockInShared?.count ?? 9) <= 3)} 本`);
console.log(`桌上有真凶点名卡的剧本：${countWith((r) => r.namingClueIds.length > 0)} 本；有"点名＋行为"同句指认卡的：${countWith((r) => r.accusingClueIds.length > 0)} 本；卡内带判词的：${countWith((r) => r.verdictClueIds.length > 0)} 本；有无辜者目击被抹名的：${countWith((r) => r.blankedWitnesses.length > 0)} 本`);
for (const r of reports) {
  const ids = [...new Set(r.rounds.flatMap((x) => x.singleCardClueIds))];
  if (ids.length) console.log(`  单卡锁凶 ${r.title}（真凶 ${r.culpritName}）→ ${ids.join("、")}`);
}
for (const f of failed) console.log(`  ! ${f}`);

mkdirSync(resolve("docs/design-packages"), { recursive: true });
writeFileSync(resolve("docs/design-packages/lock-metric.json"), JSON.stringify({ generatedAt: new Date().toISOString(), corpus: "seeds/*.json + seeds/generated/*.json", reports }, null, 2) + "\n");
console.log(`\n基线已写入 docs/design-packages/lock-metric.json`);
