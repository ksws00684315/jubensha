import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seedScript, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";

beforeEach(async () => {
  await setupIntEnv();
  await truncateAll();
});

afterEach(async () => {
  await teardownIntEnv();
});

async function seedRoomAndGame() {
  const script = await seedScript();
  const room = await db.room.create({
    data: { code: "CHK01", scriptId: script.id, hostToken: "test-host" },
  });
  const game = await db.game.create({ data: { roomId: room.id, scriptId: script.id } });
  return { script, room, game };
}

describe("L3：稳定字符串 CHECK 约束（I13）", () => {
  it("拒绝 rooms.status 非法值", async () => {
    const { room } = await seedRoomAndGame();
    await expect(db.$executeRaw`UPDATE rooms SET status = 'invalid' WHERE id = ${room.id}`).rejects.toThrow();
  });

  it("拒绝 seats.kind 非法值", async () => {
    const { room } = await seedRoomAndGame();
    const seat = await db.seat.create({ data: { roomId: room.id, index: 0, kind: "human" } });
    await expect(db.$executeRaw`UPDATE seats SET kind = 'invalid' WHERE id = ${seat.id}`).rejects.toThrow();
  });

  it("拒绝 games.status 非法值", async () => {
    const { game } = await seedRoomAndGame();
    await expect(db.$executeRaw`UPDATE games SET status = 'invalid' WHERE id = ${game.id}`).rejects.toThrow();
  });

  it("拒绝 games.phase 非法值", async () => {
    const { game } = await seedRoomAndGame();
    await expect(db.$executeRaw`UPDATE games SET phase = 'invalid' WHERE id = ${game.id}`).rejects.toThrow();
  });

  it("拒绝 ai_providers.protocol 非法值", async () => {
    const provider = await db.aiProvider.create({
      data: { name: "test", baseUrl: "http://localhost", apiKeyCipher: "test-cipher" },
    });
    await expect(db.$executeRaw`UPDATE ai_providers SET protocol = 'invalid' WHERE id = ${provider.id}`).rejects.toThrow();
  });

  it("拒绝 scripts.source 非法值", async () => {
    const script = await seedScript();
    await expect(db.$executeRaw`UPDATE scripts SET source = 'invalid' WHERE id = ${script.id}`).rejects.toThrow();
  });

  it("拒绝 scripts.difficulty 非法值", async () => {
    const script = await seedScript();
    await expect(db.$executeRaw`UPDATE scripts SET difficulty = 'invalid' WHERE id = ${script.id}`).rejects.toThrow();
  });
});
