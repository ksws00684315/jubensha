import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "../src/lib/app-config";
async function main() {
  const label = process.argv[2] ?? "chen_man-1";
  const dir = ".workbuddy/audit/playtest-2026-09-21";
  const { gameId } = JSON.parse(readFileSync(`${dir}/${label}-identity.json`, "utf8"));
  const db = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl().url! } } });
  try {
    const [game, events, usage] = await Promise.all([db.game.findUnique({ where: { id: gameId } }), db.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" } }), db.usageLog.findMany({ where: { gameId }, orderBy: { createdAt: "asc" } })]);
    writeFileSync(`${dir}/${label}-checkpoint.json`, JSON.stringify({ game, events, usage }, (_, value) => typeof value === "bigint" ? String(value) : value, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: game?.phase, round: game?.round, events: events.slice(-8).map((e) => ({ type: e.type, from: e.fromSeat, content: e.content })), calls: usage.length, failures: usage.filter((u) => !u.ok).map((u) => ({ task: u.taskType, error: u.error })) }, null, 2));
  } finally { await db.$disconnect(); }
}
void main();
