import { execSync } from "node:child_process";

/**
 * L3 全局 setup：
 * 1. DATABASE_URL 必须指向 jubensha_test —— 防误连用户库（写坏无法挽回）；
 * 2. prisma migrate deploy 建表；
 * 3. APP_CONFIG_PATH 指向不存在的文件，避免读到 local.app.json（依赖 S1.2）。
 */
export default function setup(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("jubensha_test")) {
    throw new Error(
      "集成测试拒绝运行：DATABASE_URL 必须包含 jubensha_test（当前未设置或不匹配）。请先 npm run db:test:up 并导出 DATABASE_URL。"
    );
  }
  process.env.APP_CONFIG_PATH = "/nonexistent/app-config-int.json";
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, APP_CONFIG_PATH: "/nonexistent/app-config-int.json" },
  });
}
