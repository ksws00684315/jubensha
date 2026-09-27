/**
 * S4.3：`games.state` 快照的版本迁移与 schema 校验。
 * fixtures 都是改动前的代码真实跑出来的 v0 快照（`__fixtures__/state/`），
 * 其中 `v0-live-e2e.json` 直接取自 e2e 库中一局停在 DISCUSSION 的线上形态快照。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_STATE_VERSION, migrateState } from "./state-migrate";
import { GameStateSchema } from "./state-schema";
import { initialState } from "./state";
import type { GameState } from "./types";

const DIR = path.join(process.cwd(), "src/core/engine/__fixtures__/state");
const V0_FIXTURES = [
  "v0-reading.json",
  "v0-search.json",
  "v0-discussion.json",
  "v0-vote.json",
  "v0-ended.json",
  "v0-live-e2e.json",
  "v0-oldest.json",
] as const;

/** 2100-01-01：晚于所有 fixture 里的 humanDeadlines，作为「重启时刻」的固定基准 */
const NOW = 4_102_443_600_000;
const GAME_ID = "game-migrate";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(DIR, name), "utf-8")) as Record<string, unknown>;
}

function migrate(name: string, ctx: { now?: number; gameId?: string } = {}): GameState {
  return migrateState(fixture(name), { now: ctx.now ?? NOW, gameId: ctx.gameId ?? GAME_ID });
}

describe("v0 快照迁移", () => {
  for (const name of V0_FIXTURES) {
    it(`${name}：迁移后通过 schema 校验并升到最新版本`, () => {
      const raw = fixture(name);
      expect(raw.stateVersion).toBeUndefined(); // 确认这些确实是 v0 快照
      const state = migrate(name);
      expect(state.stateVersion).toBe(CURRENT_STATE_VERSION);
      expect(GameStateSchema.safeParse(state).success).toBe(true);
      expect(state.phase).toBe(raw.phase);
      expect(state.round).toBe(raw.round);
      expect(state.seats).toEqual(raw.seats);
    });

    it(`${name}：迁移幂等（再过一次不改变结果）`, () => {
      const once = migrate(name);
      expect(migrateState(once, { now: NOW, gameId: GAME_ID })).toEqual(once);
    });
  }

  it("最老格式：后加的可选字段全部补上默认值", () => {
    const state = migrate("v0-oldest.json");
    const defaulted = ["actionPlans", "interactionChoices", "actionPoints", "usedSkills", "quizAnswers", "humanDeadlines", "unlockedSecrets", "hostHandouts", "hostHints", "guaranteeDeferUntil", "readingPromptedSeats"];
    for (const field of defaulted) {
      expect(state[field as keyof GameState], field).not.toBeUndefined();
    }
    // suggestions / memory 从来不在补默认之列：读侧一律用 `state.x?.` 兜底，行为与旧 load() 一致
    expect(state.suggestions).toBeUndefined();
    expect(state.memory).toBeUndefined();
    expect(state.pendingInteraction).toBeNull();
    expect(state.quizResult).toBeNull();
    expect(state.interjections).toBe(0);
  });

  it("最老格式：缺 questionId 的提问按 legacy 规则补 id（含对局 id 与座位）", () => {
    const answer = fixture("v0-oldest.json").pendingAnswer as { fromSeat: number; toSeat: number };
    const state = migrate("v0-oldest.json");
    expect(state.pendingAnswer?.questionId).toBe(`legacy:${GAME_ID}:${state.round}:${answer.fromSeat}:${answer.toSeat}`);
    // 已有 questionId 时不覆盖
    const again = migrateState(state, { now: NOW, gameId: GAME_ID });
    expect(again.pendingAnswer?.questionId).toBe(state.pendingAnswer?.questionId);
  });

  it("最老格式：已被主持公开的线索不会留在待决策队列里（否则搜证死锁）", () => {
    const raw = fixture("v0-oldest.json");
    const published = Object.keys(raw.clueStates as Record<string, { isPublic: boolean }>).filter((id) => (raw.clueStates as Record<string, { isPublic: boolean }>)[id].isPublic);
    expect((raw.pendingPublish as Record<string, string[]>)["0"].length).toBeGreaterThan(0);
    const state = migrate("v0-oldest.json");
    for (const ids of Object.values(state.pendingPublish)) {
      expect(ids.filter((id) => published.includes(id))).toEqual([]);
    }
  });

  it("重启后已过期的真人限时截止被清掉，未过期的保留", () => {
    const base = fixture("v0-search.json");
    const deadlines = base.humanDeadlines as Record<string, number>;
    expect(Object.keys(deadlines).length).toBeGreaterThan(0);
    const seat = Object.keys(deadlines)[0];
    // fixture 里的截止时间点：早于它 → 尚未过期
    expect(migrate("v0-search.json", { now: deadlines[seat] - 1_000 }).humanDeadlines?.[seat]).toBe(deadlines[seat]);
    expect(migrate("v0-search.json", { now: NOW }).humanDeadlines?.[seat]).toBeUndefined();
  });

});

describe("schema 校验", () => {
  it("未登记字段原样保留（.loose），不会让旧快照校验失败", () => {
    const state = migrateState({ ...fixture("v0-live-e2e.json"), someFutureField: { a: 1 } }, { now: NOW, gameId: GAME_ID });
    const persisted = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    expect(persisted.someFutureField).toEqual({ a: 1 });
  });

  it("结构性错误被拒绝：阶段未知 / seats 不是数组 / 座位缺 kind", () => {
    const bad = (patch: Record<string, unknown>) => () => migrateState({ ...fixture("v0-live-e2e.json"), ...patch }, { now: NOW, gameId: GAME_ID });
    expect(bad({ phase: "SETTLEMENT" })).toThrow();
    expect(bad({ seats: "0,1,2" })).toThrow();
    expect(bad({ seats: [{ index: 0, characterId: "a", playerName: "甲" }] })).toThrow();
    expect(bad({ clueStates: { c1: { discoveredBy: null } } })).toThrow();
  });

  it("高于当前版本的快照（回滚场景）不被降级改写", () => {
    const state = migrateState({ ...fixture("v0-live-e2e.json"), stateVersion: CURRENT_STATE_VERSION + 1 }, { now: NOW, gameId: GAME_ID });
    expect(state.stateVersion).toBe(CURRENT_STATE_VERSION + 1);
  });
});

describe("空快照兜底", () => {
  it("games.state 为 null / 缺失 / 非对象时按空座位开局状态加载", () => {
    const expected = {
      ...initialState([]),
      actionPoints: {},
      humanDeadlines: {},
      quizAnswers: {},
      quizResult: null,
      usedSkills: [],
    };
    for (const raw of [null, undefined, "broken", 42]) {
      expect(migrateState(raw, { now: NOW, gameId: GAME_ID })).toEqual(expected);
    }
  });
});

describe("新建对局", () => {
  it("initialState 直接带最新版本号，无需迁移即可通过校验", () => {
    const state = initialState([{ index: 0, kind: "human", characterId: "qinghe", playerName: "甲" }]);
    expect(state.stateVersion).toBe(CURRENT_STATE_VERSION);
    expect(GameStateSchema.safeParse(state).success).toBe(true);
  });
});
