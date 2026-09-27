/* e2e 实例收尾：按 pid 文件杀进程；--keep-db 保留 jubensha_e2e 库（R4 使用）。 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PID_FILE = path.join(ROOT, ".e2e", "up.json");
const keepDb = process.argv.includes("--keep-db");

function isAlive(pid) {
  const r = spawnSync("kill", ["-0", String(pid)], { stdio: "pipe" });
  return r.status === 0;
}

function main() {
  if (existsSync(PID_FILE)) {
    const { pid, port } = JSON.parse(readFileSync(PID_FILE, "utf8"));
    if (port === 3000) {
      console.error("拒绝：pid 文件指向 :3000（用户实例），不操作。请人工检查 .e2e/up.json。");
      process.exit(1);
    }
    try {
      // detached spawn 使 child 成为进程组长：kill 进程组连带 next server
      execSync(`kill -- -${pid} 2>/dev/null || kill ${pid} 2>/dev/null || true`, { stdio: "pipe" });
      const deadline = Date.now() + 5_000;
      while (isAlive(pid) && Date.now() < deadline) {
        spawnSync("sleep", ["0.2"]);
      }
      if (isAlive(pid)) {
        console.warn(`[e2e:down] pid=${pid} 5s 内未退出，发送 SIGKILL`);
        execSync(`kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null || true`, { stdio: "pipe" });
      }
      console.log(`[e2e:down] 实例 pid=${pid} 已停止`);
    } catch {
      console.log(`[e2e:down] pid=${pid} 已不存在`);
    }
    rmSync(PID_FILE);
  } else {
    console.log("[e2e:down] 无 pid 文件，跳过进程清理");
  }

  if (!keepDb) {
    try {
      execSync(
        `docker exec jubensha-pg-test psql -U postgres -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='jubensha_e2e' AND pid <> pg_backend_pid()"`,
        { stdio: "pipe" }
      );
      execSync(`docker exec jubensha-pg-test psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS jubensha_e2e"`, { stdio: "pipe" });
      console.log("[e2e:down] jubensha_e2e 库已删除");
    } catch (e) {
      console.error("[e2e:down] 删库失败（pg-test 容器未运行？）:", e.message);
    }
  } else {
    console.log("[e2e:down] --keep-db：保留 jubensha_e2e 库");
  }
}

main();
