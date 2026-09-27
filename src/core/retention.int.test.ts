import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runRetention } from "../../scripts/retention";
import { seedScript, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";

beforeEach(async () => {
  await setupIntEnv();
  await truncateAll();
});
afterEach(async () => {
  await teardownIntEnv();
});

async function seedGame(code: string, status: "ended" | "aborted" | "running", endedAt: Date | null) {
  const script = await seedScript();
  const room = await db.room.create({ data: { code, scriptId: script.id, status: "ended" } });
  return db.game.create({ data: { roomId: room.id, scriptId: script.id, status, endedAt } });
}

async function seedDependents(gameId: string, createdAt: Date) {
  await db.gameEvent.create({ data: { gameId, type: "system", phase: "ENDED", visibility: "public", content: { text: "test" }, createdAt } });
  await db.seatState.create({ data: { gameId, seatIndex: 0 } });
  await db.vote.create({ data: { gameId, seatIndex: 0, targetIndex: 1, createdAt } });
  await db.privateMessage.create({ data: { gameId, fromSeat: 0, toSeat: 1, content: "test", createdAt } });
  await db.eventVector.create({ data: { gameId, seq: BigInt(1), vector: [0.1], dimension: 1 } });
}

describe("L3：数据保留（I12）", () => {
  it("dry-run 统计候选行但不删除任何数据", async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const oldGame = await seedGame("RET01", "ended", new Date(cutoff.getTime() - 1));
    await seedDependents(oldGame.id, new Date(cutoff.getTime() - 1));
    const oldUsage = await db.usageLog.create({ data: { providerName: "test", modelId: "test", purpose: "player", totalTokens: 1, createdAt: new Date(cutoff.getTime() - 1) } });
    const oldJev = await db.jevShadowLog.create({ data: { gameId: oldGame.id, slot: "vote", seatIndex: 0, phase: "VOTE", round: 1, createdAt: new Date(cutoff.getTime() - 1) } });

    const counts = await runRetention(db, cutoff, false);
    expect(counts).toMatchObject({ games: 1, game_events: 1, seat_states: 1, votes: 1, private_messages: 1, event_vectors: 1, usage_logs: 1, jev_shadow_logs: 1 });
    expect(await db.game.count()).toBe(1);
    expect(await db.usageLog.findUnique({ where: { id: oldUsage.id } })).not.toBeNull();
    expect(await db.jevShadowLog.findUnique({ where: { id: oldJev.id } })).not.toBeNull();
    expect(await db.gameEvent.count({ where: { gameId: oldGame.id } })).toBe(1);
  }, 60_000);

  it("apply 只删超期 ended/aborted 对局及关联行和超期日志", async () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const oldAt = new Date(cutoff.getTime() - 1);
    const recentAt = new Date(cutoff.getTime() + 1);
    const expired = await seedGame("RET02", "aborted", oldAt);
    await seedDependents(expired.id, oldAt);
    const recent = await seedGame("RET03", "ended", recentAt);
    const active = await seedGame("RET04", "running", oldAt);
    const oldUsage = await db.usageLog.create({ data: { providerName: "test", modelId: "test", purpose: "player", totalTokens: 1, createdAt: oldAt } });
    const newUsage = await db.usageLog.create({ data: { providerName: "test", modelId: "test", purpose: "player", totalTokens: 1, createdAt: recentAt } });
    const oldJev = await db.jevShadowLog.create({ data: { gameId: expired.id, slot: "vote", seatIndex: 0, phase: "VOTE", round: 1, createdAt: oldAt } });
    const newJev = await db.jevShadowLog.create({ data: { gameId: recent.id, slot: "vote", seatIndex: 0, phase: "VOTE", round: 1, createdAt: recentAt } });

    const counts = await runRetention(db, cutoff, true);
    expect(counts.games).toBe(1);
    expect(await db.game.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await db.game.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.game.findUnique({ where: { id: active.id } })).not.toBeNull();
    expect(await db.gameEvent.count({ where: { gameId: expired.id } })).toBe(0);
    expect(await db.seatState.count({ where: { gameId: expired.id } })).toBe(0);
    expect(await db.vote.count({ where: { gameId: expired.id } })).toBe(0);
    expect(await db.privateMessage.count({ where: { gameId: expired.id } })).toBe(0);
    expect(await db.eventVector.count({ where: { gameId: expired.id } })).toBe(0);
    expect(await db.usageLog.findUnique({ where: { id: oldUsage.id } })).toBeNull();
    expect(await db.usageLog.findUnique({ where: { id: newUsage.id } })).not.toBeNull();
    expect(await db.jevShadowLog.findUnique({ where: { id: oldJev.id } })).toBeNull();
    expect(await db.jevShadowLog.findUnique({ where: { id: newJev.id } })).not.toBeNull();
  }, 60_000);

  it("apply 缺少库名确认时命令拒绝且不连接数据库", () => {
    const result = spawnSync("node", ["--import", "tsx", "scripts/retention.ts", "--apply"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/jubensha_test" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("apply 需要 --confirm jubensha_test");
    expect(result.stdout + result.stderr).toContain("未连接数据库、未删除数据");
  });
});
