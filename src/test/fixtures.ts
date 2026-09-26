import { readFileSync } from "node:fs";
import path from "node:path";

/** 行工厂：字段以 prisma/schema.prisma 为准，测试里只覆写关心的列。 */

export function roomRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "room-1",
    code: "ABCDE",
    scriptId: "script-1",
    status: "lobby",
    humanDm: false,
    unlimitedHumanTurns: true,
    dmToken: null,
    dmName: null,
    hostToken: "host-token-1",
    createdAt: new Date("2026-09-26T00:00:00Z"),
    updatedAt: new Date("2026-09-26T00:00:00Z"),
    seats: [],
    game: null,
    ...overrides,
  };
}

export function seatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "seat-1",
    roomId: "room-1",
    index: 0,
    kind: "human",
    playerName: "玩家一",
    characterId: "char-a",
    token: "seat-token-1",
    ready: false,
    ...overrides,
  };
}

export function gameRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "game-1",
    roomId: "room-1",
    scriptId: "script-1",
    status: "running",
    phase: "DISCUSSION",
    round: 1,
    state: {},
    scriptSnapshot: null,
    scriptHash: null,
    scriptSnapshotSource: null,
    createdAt: new Date("2026-09-26T00:00:00Z"),
    endedAt: null,
    room: undefined,
    script: undefined,
    ...overrides,
  };
}

let exampleScriptContent: unknown | null = null;

/** 剧本行：content 用仓库内置的 V2 示例剧本，保证 schema 校验可通过。 */
export function scriptRow(overrides: Record<string, unknown> = {}) {
  if (exampleScriptContent === null) {
    const file = path.join(process.cwd(), "seeds/examples/script-v2.example.json");
    exampleScriptContent = JSON.parse(readFileSync(file, "utf8"));
  }
  const doc = exampleScriptContent as { title?: string; meta?: Record<string, unknown> };
  const meta = doc.meta ?? {};
  return {
    id: "script-1",
    title: doc.title ?? "示例剧本",
    minPlayers: (meta.minPlayers as number | undefined) ?? 3,
    maxPlayers: (meta.maxPlayers as number | undefined) ?? 8,
    durationMin: (meta.durationMin as number | undefined) ?? 120,
    difficulty: (meta.difficulty as string | undefined) ?? "新手",
    tags: [],
    intro: "",
    content: exampleScriptContent,
    designPackage: null,
    designHash: null,
    designReview: null,
    source: "manual",
    deleted: false,
    createdAt: new Date("2026-09-26T00:00:00Z"),
    updatedAt: new Date("2026-09-26T00:00:00Z"),
    ...overrides,
  };
}
