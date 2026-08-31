/* 导出初始化包：剧本 + AI Provider + 槽位绑定（不含房间/对局/用量） */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

function loadDatabaseUrl() {
  if (existsSync("local.app.json")) {
    const cfg = JSON.parse(readFileSync("local.app.json", "utf8"));
    if (typeof cfg.databaseUrl === "string" && cfg.databaseUrl.trim()) return cfg.databaseUrl.trim();
  }
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync(".env")) {
    const m = readFileSync(".env", "utf8").match(/^DATABASE_URL="?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  throw new Error("找不到 DATABASE_URL（local.app.json / 环境变量 / .env）");
}

const out = process.argv[2] || "local.init.json";
const db = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const [scripts, providers, bindings] = await Promise.all([
  db.script.findMany({ where: { deleted: false }, orderBy: { createdAt: "asc" } }),
  db.aiProvider.findMany({ orderBy: { createdAt: "asc" } }),
  db.modelBinding.findMany({ orderBy: { slot: "asc" } }),
]);

const snapshot = {
  version: 1,
  exportedAt: new Date().toISOString(),
  scripts: scripts.map((s) => ({
    id: s.id,
    title: s.title,
    minPlayers: s.minPlayers,
    maxPlayers: s.maxPlayers,
    durationMin: s.durationMin,
    difficulty: s.difficulty,
    tags: s.tags,
    intro: s.intro,
    content: s.content,
    source: s.source,
  })),
  providers: providers.map((p) => ({
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKeyCipher: p.apiKeyCipher,
    enabled: p.enabled,
    note: p.note,
  })),
  bindings: bindings.map((b) => ({
    slot: b.slot,
    providerId: b.providerId,
    modelId: b.modelId,
    temperature: b.temperature,
    maxTokens: b.maxTokens,
    fallbackSlot: b.fallbackSlot,
  })),
};

writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(`exported ${scripts.length} scripts, ${providers.length} providers, ${bindings.length} bindings -> ${out}`);
console.log("注意：Provider 密文依赖同一把 SECRET_MASTER_KEY；房间/对局/用量未导出。");
await db.$disconnect();
