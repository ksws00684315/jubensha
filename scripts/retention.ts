import { PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const GAME_TABLES = ["game_events", "seat_states", "votes", "private_messages", "event_vectors"] as const;
const TABLES = [...GAME_TABLES, "games", "usage_logs", "jev_shadow_logs"] as const;

export interface RetentionOptions {
  days: number;
  apply: boolean;
  confirm: string | null;
}

export function parseArgs(args: string[]): RetentionOptions {
  let days = 90;
  let apply = false;
  let confirm: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--days" || arg.startsWith("--days=")) {
      const value = arg === "--days" ? args[++i] : arg.slice("--days=".length);
      days = Number(value);
      if (!Number.isSafeInteger(days) || days < 1) throw new Error("--days 必须是正整数");
    } else if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      confirm = arg === "--confirm" ? args[++i] ?? null : arg.slice("--confirm=".length);
      if (!confirm) throw new Error("--confirm 需要数据库名");
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { days, apply, confirm };
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function maskedTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//***@${parsed.host}/${decodeURIComponent(parsed.pathname.slice(1))}`;
  } catch {
    return "[数据库 URL 已隐藏]";
  }
}

type RetentionDb = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Counts = Record<(typeof TABLES)[number], number>;

export async function collectCounts(client: RetentionDb, cutoff: Date): Promise<Counts> {
  const counts = {} as Counts;
  for (const table of GAME_TABLES) {
    const rows = await client.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM "${table}" WHERE "gameId" IN (SELECT id FROM games WHERE status IN ('ended', 'aborted') AND "endedAt" < $1)`,
      cutoff,
    );
    counts[table] = rows[0]?.count ?? 0;
  }
  const games = await client.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM games WHERE status IN ('ended', 'aborted') AND "endedAt" < $1`,
    cutoff,
  );
  counts.games = games[0]?.count ?? 0;
  for (const table of ["usage_logs", "jev_shadow_logs"] as const) {
    const rows = await client.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM "${table}" WHERE "createdAt" < $1`,
      cutoff,
    );
    counts[table] = rows[0]?.count ?? 0;
  }
  return counts;
}

export async function runRetention(client: PrismaClient, cutoff: Date, apply: boolean): Promise<Counts> {
  const counts = await collectCounts(client, cutoff);
  if (!apply) return counts;
  const expiredGames = `SELECT id FROM games WHERE status IN ('ended', 'aborted') AND "endedAt" < $1`;
  const operations = [
    ...GAME_TABLES.map((table) => client.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "gameId" IN (${expiredGames})`, cutoff)),
    client.$executeRawUnsafe(`DELETE FROM games WHERE id IN (${expiredGames})`, cutoff),
    client.$executeRawUnsafe('DELETE FROM "usage_logs" WHERE "createdAt" < $1', cutoff),
    client.$executeRawUnsafe('DELETE FROM "jev_shadow_logs" WHERE "createdAt" < $1', cutoff),
  ];
  await client.$transaction(operations);
  return counts;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("必须显式设置 DATABASE_URL；本脚本不读取应用配置文件");
  const targetName = databaseName(url);
  console.log(`目标数据库：${maskedTarget(url)}`);
  console.log(`保留期限：${options.days} 天；模式：${options.apply ? "apply" : "dry-run"}`);
  if (options.apply && options.confirm !== targetName) {
    throw new Error(`apply 需要 --confirm ${targetName}，当前未匹配，未连接数据库、未删除数据`);
  }

  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
    const counts = await runRetention(client, cutoff, options.apply);
    for (const table of TABLES) console.log(`${table}: ${counts[table]}`);
    console.log(options.apply ? "清理事务已提交" : "dry-run：未删除任何数据");
  } finally {
    await client.$disconnect();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "数据保留脚本执行失败");
    process.exitCode = 1;
  });
}
