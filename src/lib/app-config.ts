import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AppConfig = {
  databaseUrl?: string;
};

export const APP_CONFIG_FILE = "local.app.json";

export function appConfigPath(): string {
  return path.join(process.cwd(), APP_CONFIG_FILE);
}

export function readAppConfig(): AppConfig {
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

export function writeAppConfig(patch: AppConfig): AppConfig {
  const next: AppConfig = { ...readAppConfig(), ...patch };
  writeFileSync(appConfigPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
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
