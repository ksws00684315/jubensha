/* e2e 实例管理：启动隔离的 :3100 实例 + jubensha_e2e 专用库。
 * 用法：node scripts/e2e/up.mjs   （scripts/e2e/down.mjs 收尾）
 * 红线：绝不触碰 :3000 的用户进程与 local.app.json / 用户库。 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = process.cwd();
const E2E_DIR = path.join(ROOT, ".e2e");
const ALLOW_3000 = process.env.E2E_ALLOW_3000 === "1";
const PREF_PORT = Number(process.env.E2E_PORT ?? 3100);
const PORT_CANDIDATES = [PREF_PORT, 3110, 3120].filter((p) => p !== 3000 || ALLOW_3000);

function isPortFree(port) {
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: "pipe" });
    return false; // 有进程在监听
  } catch {
    return true;
  }
}

const PORT = PORT_CANDIDATES.find(isPortFree);
if (PREF_PORT === 3000 && !ALLOW_3000) {
  console.error("拒绝启动：E2E_PORT 不能是 3000（用户实例）。除非显式 E2E_ALLOW_3000=1。");
  process.exit(1);
}
if (!PORT) {
  console.error(`拒绝启动：${PORT_CANDIDATES.join(" / ")} 全部被占用。请人工清理遗留实例后重试。`);
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/jubensha_e2e";
const ADMIN_TOKEN = randomBytes(16).toString("hex");
const MASTER_KEY = randomBytes(24).toString("hex");
const PID_FILE = path.join(E2E_DIR, "up.json");
const KEEP_DB = process.argv.includes("--keep-db");

const log = (...a) => console.log("[e2e:up]", ...a);
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });

function ensurePg() {
  sh("docker compose -f docker-compose.test.yml up -d --wait");
}

function resetE2eDb() {
  sh(
    `docker exec jubensha-pg-test psql -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='jubensha_e2e' AND pid <> pg_backend_pid()"`,
    { stdio: "pipe" }
  );
  sh(`docker exec jubensha-pg-test psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS jubensha_e2e"`, { stdio: "pipe" });
  sh(`docker exec jubensha-pg-test psql -U postgres -d postgres -c "CREATE DATABASE jubensha_e2e"`, { stdio: "pipe" });
}

function newestMtime(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.mtimeMs;
    let m = st.mtimeMs;
    for (const child of readdirSync(p)) {
      if (child === "node_modules" || child === ".next" || child.startsWith(".")) continue;
      m = Math.max(m, newestMtime(path.join(p, child)));
    }
    return m;
  } catch {
    return 0;
  }
}

function buildIfStale() {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  const builtAt = existsSync(buildId) ? statSync(buildId).mtimeMs : 0;
  const newestSrc = ["src", "scripts", "prisma", "public"].reduce((acc, dir) => Math.max(acc, newestMtime(path.join(ROOT, dir))), 0);
  if (builtAt > newestSrc) {
    log("构建产物已是最新的，跳过 build");
    return;
  }
  log("构建产物过期，执行 npm run build …");
  sh("npm run build");
}

const ENV = {
  ...process.env,
  PORT: String(PORT),
  HOSTNAME: "127.0.0.1",
  NODE_ENV: "production",
  APP_CONFIG_PATH: path.join(E2E_DIR, "app.json"), // 隔离配置，绝不读 local.app.json
  DATABASE_URL: DB_URL,
  ADMIN_TOKEN,
  SECRET_MASTER_KEY: MASTER_KEY,
};
// 实机只跑无模型链路（除 R8 的真模型场景，用的是 E2E_LLM_*）：仓库 .env 里开着 Jev 影子/接管时，
// 下一局就会对每个 AI 座位向外部决策端点发真付费请求。
// 只从父进程 env 里删键是拦不住的：next start 子进程首次实例化 Prisma Client 时会自己读仓库根 .env
// 把 JEV_* 灌回来（FIND-07）。显式置成非 "1" 才有效——dotenv 不覆盖已存在的键。
for (const key of Object.keys(ENV)) if (key.startsWith("JEV_")) delete ENV[key];
ENV.JEV_SHADOW = "0";
ENV.JEV_FALLBACK = "0";

async function waitForReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function importSeed(doc, adminToken) {
  const res = await fetch(`${BASE}/api/scripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify(doc),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`导入剧本失败 ${doc.meta?.title}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.id;
}

async function main() {
  mkdirSync(E2E_DIR, { recursive: true });
  ensurePg();
  if (KEEP_DB) {
    log("--keep-db：沿用现有 jubensha_e2e 库（R4 重启恢复用）");
  } else {
    resetE2eDb();
    log("jubensha_e2e 库已重置");
  }

  buildIfStale();
  log("prisma migrate deploy …");
  sh("npx prisma migrate deploy", { env: { ...ENV, APP_CONFIG_PATH: "/nonexistent/app-config-e2e.json" } });

  const out = path.join(E2E_DIR, "instance.log");
  // 直接给子进程文件描述符：父进程退出后管道会断，用管道会让实例写日志时拿到 EPIPE
  const fd = openSync(out, "a");
  const child = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: ENV,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);

  writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, adminToken: ADMIN_TOKEN, db: DB_URL, log: out }, null, 2) + "\n");
  log(`实例已启动 pid=${child.pid} port=${PORT} 日志=${out}`);

  if (!(await waitForReady())) {
    console.error("实例 60s 内未就绪，查看日志：", out);
    process.exit(1);
  }
  log("实例就绪");

  // 导入种子：5 人本（R1 用）+ 4 人本 + 6 人本各一；--keep-db 时库里已有，跳过
  if (!KEEP_DB) {
    const seeds = ["seeds/sample-5p-cloudlanshan.json", "seeds/generated/4p-huoguoju.json", "seeds/generated/06p-hongyanbanhang.json"];
    for (const f of seeds) {
      const doc = JSON.parse(readFileSync(path.join(ROOT, f), "utf8"));
      const id = await importSeed(doc, ADMIN_TOKEN);
      log(`已导入 ${doc.meta.title} (${f}) -> ${id}`);
    }
  }
  log("UP 完成");
  child.unref();
  process.exit(0);
}

main().catch((e) => {
  console.error("[e2e:up] 失败:", e.message);
  process.exit(1);
});
