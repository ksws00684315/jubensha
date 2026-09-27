/* S4.1 验收 2：跑 R1（scripts/smoke-m3.mjs 原样），同时采样 games.leaseUntil 的变化次数，
 * 用来数「续租写入」。leaseUntil 只被 acquire/renew 写过，值变一次 = 一次写。
 * 判据：续租次数 ≈ 持牌时长 / 10s（±20%）。
 * 用法：node scripts/e2e/r1-lease-meter.mjs   （前置 npm run e2e:up） */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const cfgPath = path.join(ROOT, ".e2e", "up.json");
if (!existsSync(cfgPath)) {
  console.error("缺少 .e2e/up.json：先跑 npm run e2e:up");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
if (cfg.port === 3000) {
  console.error("拒绝：实例端口是 3000（用户进程）。");
  process.exit(1);
}
const DB = String(cfg.db);
const log = (...a) => console.log("[r1-meter]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Array<{id: string, leaseEpoch: number|null}>} */
function sample() {
  const r = spawnSync("psql", [DB, "-At", "-c", 'select id||\'|\'||coalesce(extract(epoch from "leaseUntil")::bigint::text, \'\') from games;'], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("psql 采样失败：" + (r.stderr || "").trim().slice(0, 200));
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, epoch] = line.split("|");
      return { id, leaseEpoch: epoch ? Number(epoch) : null };
    });
}

// 开局前先记一次已有的对局：终局的引擎要等 10 分钟才驱逐交牌，
// 上一轮残留的局此刻仍在续租，混进来会把「每局续租次数」算高（第 3 轮就栽在这里）。
const knownGames = new Set(sample().map((r) => r.id));

const smoke = spawn("node", ["scripts/smoke-m3.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, SMOKE_BASE: `http://127.0.0.1:${cfg.port}`, SMOKE_ADMIN_TOKEN: String(cfg.adminToken ?? "") },
});
const smokeExit = new Promise((r) => smoke.once("close", (code) => r(code)));

const seen = new Map(); // gameId → 上一次看到的 leaseUntil
const renewals = new Map(); // gameId → 续租写入次数
let firstHeldAt = null;
let lastRenewAt = null;
const t0 = Date.now();
let smokeCode = null;
let smokeEndedAt = null;

while (Date.now() - t0 < 20 * 60_000) {
  const rows = sample();
  for (const { id, leaseEpoch } of rows) {
    if (knownGames.has(id)) continue; // 只看本轮新建的那一局
    const prev = seen.get(id);
    if (prev === leaseEpoch) continue;
    seen.set(id, leaseEpoch);
    if (leaseEpoch === null) continue; // 交牌（终局驱逐 / 主动释放），不计续租
    if (prev === undefined) {
      if (firstHeldAt === null) firstHeldAt = Date.now();
      continue; // 首次看到持牌 = acquire，不是续租
    }
    renewals.set(id, (renewals.get(id) ?? 0) + 1);
    lastRenewAt = Date.now();
  }
  if (smokeCode === null) {
    const code = await Promise.race([smokeExit, sleep(900).then(() => null)]);
    if (code !== null) {
      smokeCode = code;
      smokeEndedAt = Date.now();
    }
  } else if (Date.now() - smokeEndedAt > 45_000) {
    break; // smoke 结束后再采 45s，把终局驱逐前的最后几次续租收进来
  }
}

const total = [...renewals.values()].reduce((a, b) => a + b, 0);
const heldMs = firstHeldAt && lastRenewAt ? lastRenewAt - firstHeldAt : 0;
const expected = heldMs / 10_000;
const deviation = expected > 0 ? (total - expected) / expected : Number.NaN;
log(`smoke 退出码=${smokeCode} 采样时长=${((Date.now() - t0) / 1000).toFixed(1)}s`);
log(`持牌窗口=${(heldMs / 1000).toFixed(1)}s 续租写入=${total} 期望≈${expected.toFixed(1)} 偏差=${(deviation * 100).toFixed(1)}%`);
log("按局计数:", JSON.stringify(Object.fromEntries(renewals)));

const ok = smokeCode === 0 && Math.abs(deviation) <= 0.2;
log(ok ? "R1+续租计数 PASSED" : "FAILED（退出码或偏差超限）");
process.exit(ok ? 0 : 1);
