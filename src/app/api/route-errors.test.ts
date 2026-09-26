import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/llm/client")>();
  return { ...actual, chat: vi.fn(async () => ({ text: "{}" })) };
});

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => resetRateLimits());

const boom = () => Promise.reject(new Error("SECRET-DETAIL: 数据库口令/上游报文"));

type Case = {
  name: string;
  path: string;
  exportName: string;
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  poison: [model: string, method: string];
};

const cases: Case[] = [
  { name: "GET /api/providers", path: "./providers/route", exportName: "GET", method: "GET", url: "/api/providers", poison: ["aiProvider", "findMany"] },
  { name: "DELETE /api/providers/[id]", path: "./providers/[id]/route", exportName: "DELETE", method: "DELETE", url: "/api/providers/p1", params: { id: "p1" }, poison: ["aiProvider", "delete"] },
  { name: "GET /api/bindings", path: "./bindings/route", exportName: "GET", method: "GET", url: "/api/bindings", poison: ["modelBinding", "findMany"] },
  { name: "GET /api/settings/database", path: "./settings/database/route", exportName: "GET", method: "GET", url: "/api/settings/database", poison: ["$tx", "$transaction"] },
  { name: "GET /api/scripts", path: "./scripts/route", exportName: "GET", method: "GET", url: "/api/scripts", poison: ["script", "findMany"] },
  { name: "GET /api/scripts/[id]", path: "./scripts/[id]/route", exportName: "GET", method: "GET", url: "/api/scripts/s1", params: { id: "s1" }, poison: ["script", "findFirst"] },
  { name: "DELETE /api/scripts/[id]", path: "./scripts/[id]/route", exportName: "DELETE", method: "DELETE", url: "/api/scripts/s1", params: { id: "s1" }, poison: ["script", "update"] },
  { name: "POST /api/scripts/[id]", path: "./scripts/[id]/route", exportName: "POST", method: "POST", url: "/api/scripts/s1", params: { id: "s1" }, poison: ["script", "findFirst"] },
  { name: "GET /api/scripts/[id]/meta", path: "./scripts/[id]/meta/route", exportName: "GET", method: "GET", url: "/api/scripts/s1/meta", params: { id: "s1" }, poison: ["script", "findFirst"] },
  { name: "GET /api/usage", path: "./usage/route", exportName: "GET", method: "GET", url: "/api/usage", poison: ["usageLog", "groupBy"] },
  { name: "POST /api/rooms", path: "./rooms/route", exportName: "POST", method: "POST", url: "/api/rooms", body: { scriptId: "s", seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }] }, poison: ["script", "findFirst"] },
  { name: "GET /api/rooms/[code]", path: "./rooms/[code]/route", exportName: "GET", method: "GET", url: "/api/rooms/ABCDE", params: { code: "ABCDE" }, poison: ["room", "findUnique"] },
  { name: "POST /api/rooms/join", path: "./rooms/join/route", exportName: "POST", method: "POST", url: "/api/rooms/join", body: { code: "ABCDE", name: "x" }, poison: ["room", "findUnique"] },
  { name: "POST /api/rooms/dm-join", path: "./rooms/dm-join/route", exportName: "POST", method: "POST", url: "/api/rooms/dm-join", body: { code: "ABCDE", name: "x" }, poison: ["room", "findUnique"] },
  { name: "POST /api/rooms/[code]/start", path: "./rooms/[code]/start/route", exportName: "POST", method: "POST", url: "/api/rooms/ABCDE/start", body: { hostToken: "h" }, params: { code: "ABCDE" }, poison: ["room", "findUnique"] },
  { name: "GET /api/games/[id]", path: "./games/[id]/route", exportName: "GET", method: "GET", url: "/api/games/g1", params: { id: "g1" }, poison: ["game", "findUnique"] },
  { name: "POST /api/games/[id]/actions", path: "./games/[id]/actions/route", exportName: "POST", method: "POST", url: "/api/games/g1/actions", body: { seatIndex: 0, token: "t", action: { type: "ready" } }, params: { id: "g1" }, poison: ["game", "findUnique"] },
  { name: "POST /api/games/[id]/dm-actions", path: "./games/[id]/dm-actions/route", exportName: "POST", method: "POST", url: "/api/games/g1/dm-actions", body: { token: "t", action: { type: "nudge" } }, params: { id: "g1" }, poison: ["game", "findUnique"] },
  { name: "GET /api/games/[id]/dm-actions", path: "./games/[id]/dm-actions/route", exportName: "GET", method: "GET", url: "/api/games/g1/dm-actions?token=t", params: { id: "g1" }, poison: ["game", "findUnique"] },
  { name: "POST /api/tts", path: "./tts/route", exportName: "POST", method: "POST", url: "/api/tts", body: { gameId: "g1", eventSeq: "7", seat: 0, token: "t" }, poison: ["game", "findUnique"] },
  { name: "GET /api/tts/[hash]", path: "./tts/[hash]/route", exportName: "GET", method: "GET", url: `/api/tts/${"a".repeat(32)}`, params: { hash: "a".repeat(32) }, poison: ["ttsCache", "findUnique"] },
];

describe("A35 全处理器 500 固定文案（错误细节不外泄）", () => {
  it.each(cases)("$name", async (c) => {
    vi.mocked(mockDbInstance[c.poison[0]][c.poison[1]]).mockImplementation(boom as never);
    try {
      const mod = await import(c.path);
      const handler = mod[c.exportName];
      const req = makeReq(c.method, c.url, { body: c.body, headers: c.headers ?? adminHeaders() });
      const res = await handler(req, ctx(c.params ?? {}));
      // 无论路由自身兜底成 4xx/502 还是 withRoute 的 500，都不允许携带内部错误细节
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toContain("SECRET-DETAIL");
    } finally {
      vi.mocked(mockDbInstance[c.poison[0]][c.poison[1]]).mockReset();
    }
  });
});
