import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "@/lib/app-config";

const g = globalThis as unknown as { prisma?: PrismaClient; prismaUrl?: string };

function createClient(url: string): PrismaClient {
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
