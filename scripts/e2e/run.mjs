/* L4 场景编排：依次执行 R1（无模型冒烟）→ R2（鉴权负向）→ R3（SSE 续传）。
 * 任一失败立即退出码 1，并打印失败场景编号。 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
if (!existsSync(path.join(ROOT, ".e2e", "up.json"))) {
  console.error("未找到 .e2e/up.json —— 请先 npm run e2e:up");
  process.exit(1);
}

const scenarios = [
  { id: "R1", file: "scripts/smoke-m3.mjs", env: { SMOKE_BASE: null } },
  { id: "R2", file: "scripts/e2e/auth.mjs", env: {} },
  { id: "R3", file: "scripts/e2e/sse-resume.mjs", env: {} },
];

let failed = null;
for (const s of scenarios) {
  console.log(`\n========== ${s.id} ==========`); 
  const env = { ...process.env };
  if (s.env.SMOKE_BASE === null) {
    const cfg = JSON.parse(
      (await import("node:fs")).readFileSync(path.join(ROOT, ".e2e", "up.json"), "utf8")
    );
    env.SMOKE_BASE = `http://127.0.0.1:${cfg.port}`;
  }
  for (const [k, v] of Object.entries(s.env)) if (v) env[k] = v;
  const r = spawnSync("node", [s.file], { stdio: "inherit", cwd: ROOT, env });
  if (r.status !== 0) {
    failed = s.id;
    break;
  }
  console.log(`${s.id} PASSED`);
}

if (failed) {
  console.error(`\n失败场景：${failed}`);
  process.exit(1);
}
console.log("\nR1–R3 全部通过");
