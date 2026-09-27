/**
 * L3（I07）：用「改动前代码产出的 v0 快照」从真库恢复对局。
 * fixtures 由 S4.3 之前的引擎跑真实对局生成（`__fixtures__/state/`），
 * 这里把其中一份原样写进 games.state，再走 `GameEngine.load()`。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_LINE, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";
import { db } from "@/lib/db";
import { GameEngine } from "./engine";
import { CURRENT_STATE_VERSION } from "./state-migrate";
import { GameStateSchema } from "./state-schema";

// LLM 一律 mock：固定台词，不发真实请求
vi.mock("@/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm/client")>();
  return {
    ...actual,
    chat: vi.fn(async () => ({ text: LLM_LINE })) as never,
    chatStream: vi.fn(async function* () {
      yield LLM_LINE;
    }) as never,
    embedTexts: vi.fn(async () => null),
  };
});

beforeEach(async () => {
  await setupIntEnv();
  await truncateAll();
});
afterEach(async () => {
  await teardownIntEnv();
});

const FIXTURE_DIR = path.join(process.cwd(), "src/core/engine/__fixtures__/state");

function v0Fixture(name: string) {
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf-8")) as Record<string, unknown>;
  expect(raw.stateVersion).toBeUndefined(); // 确认这是 v0 快照
  return raw;
}

/** 以 fixture 自带的座位/角色建一局：剧本、座位、线索 id 三者必须同源 */
async function seedGameFromFixture(fixture: Record<string, unknown>) {
  const doc = JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf-8"));
  const script = await db.script.create({
    data: {
      title: "科场疑云（I07 fixture）",
      minPlayers: 5,
      maxPlayers: 5,
      durationMin: 120,
      difficulty: "新手",
      tags: ["test"],
      intro: "用于旧快照恢复的集成测试",
      content: doc as object,
      source: "manual",
    },
  });
  const seats = fixture.seats as Array<{ index: number; kind: string; characterId: string; playerName: string }>;
  const room = await db.room.create({
    data: {
      code: "MIG07",
      scriptId: script.id,
      status: "playing",
      unlimitedHumanTurns: true,
      hostToken: "host-token-7",
      seats: {
        create: seats.map((s) => ({
          index: s.index,
          kind: s.kind,
          characterId: s.characterId,
          playerName: s.playerName,
          token: s.kind === "human" ? "seat-token-7" : null,
        })),
      },
    },
    include: { seats: true },
  });
  const game = await db.game.create({
    data: {
      roomId: room.id,
      scriptId: script.id,
      status: "running",
      phase: String(fixture.phase),
      round: Number(fixture.round),
      state: fixture as object,
      scriptSnapshot: doc as object,
      scriptHash: createHash("sha256").update(JSON.stringify(doc)).digest("hex"),
      scriptSnapshotSource: "start",
    },
  });
  return { game, room };
}

describe("L3：v0 旧快照恢复（I07）", () => {
  it("I07 load 一份 v0 快照：迁移通过校验、版本号升到最新、对局可继续推进", async () => {
    const fixture = v0Fixture("v0-live-e2e.json");
    const { game } = await seedGameFromFixture(fixture);

    const engine = await GameEngine.load(game.id);
    expect(engine.state.stateVersion).toBe(CURRENT_STATE_VERSION);
    expect(GameStateSchema.safeParse(engine.state).success).toBe(true);
    expect(engine.state.phase).toBe(fixture.phase);
    expect(engine.state.round).toBe(fixture.round);
    // v0 里没有的字段被补齐
    expect(engine.state.usedSkills).toEqual([]);
    expect(engine.state.actionPoints).toEqual({});

    // 恢复后可继续推进：轮到座位 0（真人）发言，直接走真实动作链
    engine.clearTimers();
    expect(engine.state.turnSeat).toBe(0);
    expect(engine.state.spokenSeats).toEqual([]);
    const before = await db.gameEvent.count({ where: { gameId: game.id } });
    const res = await engine.handleAction(0, { type: "speak", text: "旧快照恢复后的第一句发言。" } as never);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await db.gameEvent.count({ where: { gameId: game.id } })).toBeGreaterThan(before);

    // 落库的新快照带版本号：这份 v1 快照之后可被下一次加载直接校验通过
    await engine.persist();
    const row = await db.game.findUnique({ where: { id: game.id } });
    const persisted = row!.state as Record<string, unknown>;
    expect(persisted.stateVersion).toBe(CURRENT_STATE_VERSION);
    engine.clearTimers();
  }, 120_000);

  it("I07 最老格式快照（缺后加字段、提问无 questionId）恢复后不死锁", async () => {
    const fixture = v0Fixture("v0-oldest.json");
    // 让队首座位确实有一张待决策线索，且另一张已被主持公开后仍残留在队列里
    const { game } = await seedGameFromFixture({ ...fixture, phase: "DISCUSSION" });

    const engine = await GameEngine.load(game.id);
    expect(engine.state.pendingAnswer?.questionId).toMatch(/^legacy:/);
    for (const ids of Object.values(engine.state.pendingPublish)) {
      expect(ids.filter((id) => engine.state.clueStates[id]?.isPublic)).toEqual([]);
    }
    engine.clearTimers();
  }, 120_000);
});
