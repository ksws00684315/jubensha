import { PrismaClient } from "@prisma/client";
import { appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { resolveDatabaseUrl } from "@/lib/app-config";
import { log } from "@/lib/log";

const g = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaUrl?: string;
  __jbsPrismaQueryCount?: { count: number; timer?: NodeJS.Timeout };
};

function attachQueryDiagnostics(client: PrismaClient, timingPath?: string): void {
  const countQueries = process.env.DEBUG_PRISMA_QUERY_COUNT === "1";
  if (!countQueries && !timingPath) return;
  const state = countQueries ? (g.__jbsPrismaQueryCount ??= { count: 0 }) : undefined;
  if (state && !state.timer) {
    state.timer = setInterval(() => {
      const count = state.count;
      state.count = 0;
      log.info("prisma.qpm", { count });
    }, 60_000);
    state.timer.unref();
  }
  // The listener is installed only on PrismaClient instances configured with query event logging.
  const onQuery = client.$on as unknown as (eventType: "query", callback: (event: { duration: number }) => void) => void;
  onQuery.call(client, "query", (event) => {
    if (state) state.count++;
    if (timingPath) appendFileSync(timingPath, `${event.duration}\n`);
  });
}

function createClient(url: string): PrismaClient {
  const timingFile = process.env.E2E_QUERY_TIMINGS_FILE;
  if (timingFile) {
    const e2eDir = `${resolve(process.cwd(), ".e2e")}${sep}`;
    const timingPath = resolve(timingFile);
    if (!timingPath.startsWith(e2eDir)) throw new Error("E2E_QUERY_TIMINGS_FILE must be inside .e2e");
    const client = new PrismaClient({
      datasources: { db: { url } },
      log: [{ emit: "event", level: "query" }],
    });
    attachQueryDiagnostics(client, timingPath);
    return client;
  }
  if (process.env.DEBUG_PRISMA_QUERY_COUNT === "1") {
    const client = new PrismaClient({
      datasources: { db: { url } },
      log: [{ emit: "event", level: "query" }],
    });
    attachQueryDiagnostics(client);
    return client;
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

function currentClient(): PrismaClient {
  const resolved = resolveDatabaseUrl();
  if (!resolved.url) {
    throw new Error("未配置数据库。请到「设置 → 数据库」填写 PostgreSQL 连接串。");
  }
  if (!g.prisma || g.prismaUrl !== resolved.url) {
    g.prisma = createClient(resolved.url);
    g.prismaUrl = resolved.url;
  }
  return g.prisma;
}

export async function pingDatabase(url: string): Promise<{ ok: true; hasSchema: boolean } | { ok: false; error: string }> {
  const client = createClient(url);
  try {
    await client.$queryRaw`SELECT 1`;
    let hasSchema = false;
    try {
      const rows = await client.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'scripts'
        ) AS present
      `;
      hasSchema = Boolean(rows[0]?.present);
    } catch {
      hasSchema = false;
    }
    return { ok: true, hasSchema };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.$disconnect().catch(() => null);
  }
}

export async function reconnectDatabase(url: string): Promise<void> {
  if (g.prisma) {
    await g.prisma.$disconnect().catch(() => null);
    g.prisma = undefined;
  }
  g.prisma = createClient(url);
  g.prismaUrl = url;
  await g.prisma.$connect();
}

/** 代理到当前连接，保存新地址后下次访问自动切到新 client。 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = currentClient();
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});
