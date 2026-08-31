/* 将 local.init.json 灌进当前 DATABASE_URL。先跑 prisma migrate deploy。 */
import { existsSync, readFileSync } from "node:fs";
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

const file = process.argv[2] || "local.init.json";
if (!existsSync(file)) throw new Error(`找不到 ${file}，请先 npm run db:export`);
const snapshot = JSON.parse(readFileSync(file, "utf8"));
if (snapshot.version !== 1) throw new Error(`不支持的快照版本: ${snapshot.version}`);

const db = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

let scripts = 0;
for (const s of snapshot.scripts ?? []) {
  await db.script.upsert({
    where: { id: s.id },
    create: {
      id: s.id,
      title: s.title,
      minPlayers: s.minPlayers,
      maxPlayers: s.maxPlayers,
      durationMin: s.durationMin,
      difficulty: s.difficulty,
      tags: s.tags ?? [],
      intro: s.intro,
      content: s.content,
      source: s.source ?? "import",
    },
    update: {
      title: s.title,
      minPlayers: s.minPlayers,
      maxPlayers: s.maxPlayers,
      durationMin: s.durationMin,
      difficulty: s.difficulty,
      tags: s.tags ?? [],
      intro: s.intro,
      content: s.content,
      source: s.source ?? "import",
      deleted: false,
    },
  });
  scripts++;
}

let providers = 0;
for (const p of snapshot.providers ?? []) {
  await db.aiProvider.upsert({
    where: { id: p.id },
    create: {
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeyCipher: p.apiKeyCipher,
      enabled: p.enabled ?? true,
      note: p.note ?? null,
    },
    update: {
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeyCipher: p.apiKeyCipher,
      enabled: p.enabled ?? true,
      note: p.note ?? null,
    },
  });
  providers++;
}

let bindings = 0;
for (const b of snapshot.bindings ?? []) {
  await db.modelBinding.upsert({
    where: { slot: b.slot },
    create: {
      slot: b.slot,
      providerId: b.providerId,
      modelId: b.modelId,
      temperature: b.temperature ?? null,
      maxTokens: b.maxTokens ?? null,
      fallbackSlot: b.fallbackSlot ?? null,
    },
    update: {
      providerId: b.providerId,
      modelId: b.modelId,
      temperature: b.temperature ?? null,
      maxTokens: b.maxTokens ?? null,
      fallbackSlot: b.fallbackSlot ?? null,
    },
  });
  bindings++;
}

console.log(`imported ${scripts} scripts, ${providers} providers, ${bindings} bindings from ${file}`);
await db.$disconnect();
