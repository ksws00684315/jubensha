/* 导入 seeds/generated/ 下尚未入库的剧本（按标题去重） */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const dir = path.join(process.cwd(), "seeds", "generated");

const existing = await fetch(`${BASE}/api/scripts`).then((r) => r.json());
const titles = new Set(existing.map((s) => s.title));
console.log(`库中已有 ${existing.length} 个剧本`);

let imported = 0;
let skipped = 0;
let failed = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const doc = JSON.parse(readFileSync(path.join(dir, f), "utf-8"));
  if (titles.has(doc.meta.title)) {
    skipped++;
    continue;
  }
  const res = await fetch(`${BASE}/api/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.id) {
    console.log(`✓ 导入 ${doc.meta.title} (${f}) -> ${data.id}`);
    imported++;
  } else {
    console.log(`✗ 失败 ${doc.meta.title} (${f}): ${JSON.stringify(data).slice(0, 200)}`);
    failed++;
  }
}
console.log(`\n导入 ${imported}，跳过 ${skipped}，失败 ${failed}`);
