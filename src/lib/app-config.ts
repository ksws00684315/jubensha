import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AppConfig = {
  databaseUrl?: string;
};

export const APP_CONFIG_FILE = "local.app.json";

export function appConfigPath(): string {
  return path.join(process.cwd(), APP_CONFIG_FILE);
}

/**
 * 配置读缓存。
 *
 * 注意 `db` 代理每次属性访问都会走 `resolveDatabaseUrl() → readAppConfig()`，
 * 也就是一次 AI 回合里几十次 DB 调用 → 几十次 existsSync+readFileSync 同步 syscall。
 * 这里加一层短 TTL 缓存把 syscall 摊平，同时保住"保存后立即生效"的语义：
 * `writeAppConfig` 写完直接刷新缓存，手工改文件则最多 1 秒后生效。
 */
const APP_CONFIG_TTL_MS = 1000;
let configCache: { at: number; value: AppConfig } | null = null;

function readAppConfigFromDisk(): AppConfig {
  const file = appConfigPath();
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const databaseUrl = (raw as { databaseUrl?: unknown }).databaseUrl;
    return { databaseUrl: typeof databaseUrl === "string" ? databaseUrl : undefined };
  } catch {
    return {};
  }
}

export function readAppConfig(): AppConfig {
  const now = Date.now();
  if (configCache && now - configCache.at < APP_CONFIG_TTL_MS) return configCache.value;
  const value = readAppConfigFromDisk();
  configCache = { at: now, value };
  return value;
}

export function writeAppConfig(patch: AppConfig): AppConfig {
  const next: AppConfig = { ...readAppConfig(), ...patch };
  writeFileSync(appConfigPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  configCache = { at: Date.now(), value: next };
  return next;
}

export function assertPostgresUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("数据库地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("数据库地址不是合法 URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("数据库地址必须以 postgresql:// 开头");
  }
  if (!parsed.hostname) throw new Error("数据库地址缺少主机名");
  return trimmed;
}

export function maskDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "****";
  }
}

export type DatabaseSource = "file" | "env" | "none";

export function resolveDatabaseUrl(): { url: string; source: Exclude<DatabaseSource, "none"> } | { url: null; source: "none" } {
  const fromFile = readAppConfig().databaseUrl?.trim();
  if (fromFile) return { url: fromFile, source: "file" };
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "env" };
  return { url: null, source: "none" };
}
