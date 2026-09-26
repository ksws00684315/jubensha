import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { synthesize } from "@/core/tts";
import { gameRow, seatRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/tts", () => ({ synthesize: vi.fn(async () => ({ hash: "a".repeat(32), cached: false })) }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  vi.mocked(synthesize).mockReset().mockResolvedValue({ hash: "a".repeat(32), cached: false } as never);
});

function gameForTts() {
  return gameRow({
    id: "game-1",
    room: {
      id: "room-1",
      code: "ABCDE",
      humanDm: false,
      dmToken: null,
      seats: [
        seatRow({ index: 0 }),
        seatRow({ id: "seat-2", index: 1, kind: "ai", token: "ai-token", playerName: "AI 嫌疑人", characterId: "suyu" }),
      ],
    },
  });
}

function speechEvent(overrides: Record<string, unknown> = {}) {
  return {
    seq: BigInt(7),
    gameId: "game-1",
    type: "speech",
    visibility: "public",
    fromSeat: 1,
    content: { text: "我认为凶手是船长。" },
    ...overrides,
  };
}

describe("A33 POST /api/tts", () => {
  it("无凭证 → 401", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameForTts() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "game-1", eventSeq: "7" } }), ctx({}));
    expect(res.status).toBe(401);
  });

  it("对局不存在 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "ghost", eventSeq: "7", seat: 0, token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("非公开发言 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameForTts() as never);
    vi.mocked(db.gameEvent.findUnique).mockResolvedValue(speechEvent({ visibility: "seat:0" }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "game-1", eventSeq: "7", seat: 0, token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("非 AI 发言（真人）→ 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameForTts() as never);
    vi.mocked(db.gameEvent.findUnique).mockResolvedValue(speechEvent({ fromSeat: 0 }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "game-1", eventSeq: "7", seat: 0, token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("文本 > 600 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameForTts() as never);
    vi.mocked(db.gameEvent.findUnique).mockResolvedValue(speechEvent({ content: { text: "长".repeat(601) } }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "game-1", eventSeq: "7", seat: 0, token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("合成失败 → 502 固定文案，不泄露上游报文", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameForTts() as never);
    vi.mocked(db.gameEvent.findUnique).mockResolvedValue(speechEvent() as never);
    vi.mocked(synthesize).mockRejectedValue(new Error("UPSTREAM-SECRET-DETAIL") as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "game-1", eventSeq: "7", seat: 0, token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(502);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("UPSTREAM-SECRET-DETAIL");
  });

  it("AI 公开发言 → 返回缓存地址", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(gameForTts() as never);
    vi.mocked(db.gameEvent.findUnique).mockResolvedValue(speechEvent() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/tts", { body: { gameId: "game-1", eventSeq: "7", seat: 0, token: "seat-token-1" } }), ctx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: `/api/tts/${"a".repeat(32)}`, cached: false });
  });
});
