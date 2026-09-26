import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

/** L3 集成测试公共助手。DATABASE_URL 必须指向 jubensha_test（globalSetup 已校验）。 */

export const LLM_LINE = "（测试固定台词：我昨晚在码头看到过可疑的人。）";

export async function setupIntEnv(): Promise<void> {
  process.env.APP_CONFIG_PATH = "/nonexistent/app-config-int.json";
  resetRateLimits();
}

const TABLES = [
  "scripts",
  "ai_providers",
  "model_bindings",
  "rooms",
  "seats",
  "games",
  "game_events",
  "seat_states",
  "votes",
  "private_messages",
  "event_vectors",
  "usage_logs",
  "tts_cache",
  "jev_shadow_logs",
];

export async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export function exampleScriptDoc(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(process.cwd(), "seeds/examples/script-v2.example.json"), "utf8"));
}

export async function seedScript(): Promise<{ id: string }> {
  const doc = exampleScriptDoc();
  const meta = doc.meta as { title: string; minPlayers: number; maxPlayers: number; durationMin: number; difficulty: string; tags: string[]; intro: string };
  return db.script.create({
    data: {
      title: meta.title,
      minPlayers: meta.minPlayers,
      maxPlayers: meta.maxPlayers,
      durationMin: meta.durationMin,
      difficulty: meta.difficulty,
      tags: meta.tags,
      intro: meta.intro,
      content: doc as object,
      source: "manual",
    },
  });
}

/** 标准三人房座位配置：1 真人 + 2 AI。 */
export function seats1h2a(): Array<{ kind: string; characterId: string }> {
  return [
    { kind: "human", characterId: "linhai" },
    { kind: "ai", characterId: "suyu" },
    { kind: "ai", characterId: "guchen" },
  ];
}
