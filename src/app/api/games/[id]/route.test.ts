import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { GameEngine } from "@/core/engine/engine";
import { gameRow, seatRow, scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/core/engine/engine", () => ({
  GameEngine: { get: vi.fn(() => null), load: vi.fn(async () => ({})) },
}));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

const ID = "game-1";

function runningGame(overrides: Record<string, unknown> = {}) {
  return gameRow({
    id: ID,
    state: {},
    scriptSnapshot: null,
    script: scriptRow(),
    room: {
      id: "room-1",
      code: "ABCDE",
      humanDm: false,
      dmToken: null,
      seats: [
        seatRow({ index: 0, characterId: "linhai" }),
        seatRow({ id: "seat-2", index: 1, kind: "ai", token: null, playerName: null, characterId: "suyu" }),
        seatRow({ id: "seat-3", index: 2, kind: "ai", token: null, playerName: null, characterId: "guchen" }),
      ],
    },
    ...overrides,
  });
}

async function getGame(query = "") {
  const { GET } = await import("./route");
  return GET(makeReq("GET", `/api/games/${ID}${query}`), ctx({ id: ID }));
}

describe("A28 GET /api/games/[id]", () => {
  it("对局不存在 → 404", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(null as never);
    const res = await getGame();
    expect(res.status).toBe(404);
  });

  it("匿名请求：mySeat=null，私有字段全空，且不触发引擎懒恢复", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(runningGame() as never);
    vi.mocked(db.seatState.findMany).mockResolvedValue([] as never);
    const res = await getGame();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mySeat).toBeNull();
    expect(body.seats.every((s: { myCard: unknown }) => s.myCard === null)).toBe(true);
    expect(body.myClues).toEqual([]);
    expect(body.pendingAnswer).toBeNull();
    expect(body.suggestions).toEqual([]);
    expect(body.skills).toEqual([]);
    expect(GameEngine.load).not.toHaveBeenCalled();
  });

  it("错 token → 与匿名等价，不泄露任何私有数据", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(runningGame() as never);
    vi.mocked(db.seatState.findMany).mockResolvedValue([{ seatIndex: 0, data: { clueIds: ["clue-1"] } }] as never);
    const res = await getGame("?seat=0&token=wrong");
    const body = await res.json();
    expect(body.mySeat).toBeNull();
    expect(body.myClues).toEqual([]);
    expect(body.seats.every((s: { myCard: unknown }) => s.myCard === null)).toBe(true);
  });

  it("正确 token → 返回本席 myCard，且其他座位 myCardV2 恒 null", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(runningGame() as never);
    vi.mocked(db.seatState.findMany).mockResolvedValue([{ seatIndex: 0, data: { clueIds: ["clue-1"] } }] as never);
    const res = await getGame("?seat=0&token=seat-token-1");
    const body = await res.json();
    expect(body.mySeat).toBe(0);
    expect(body.seats[0].myCard).not.toBeNull();
    expect(body.seats[0].myCard.isCulprit).toBeDefined();
    expect(body.myClues).toEqual(["clue-1"]);
    expect(body.seats[0].myCardV2).not.toBeNull();
    expect(body.seats[1].myCardV2).toBeNull();
    expect(body.seats[1].myCard).toBeNull();
    expect(GameEngine.load).toHaveBeenCalledWith(ID); // 参与者可懒恢复
  });

  it("quizResult 仅 ENDED 返回", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(runningGame() as never);
    vi.mocked(db.seatState.findMany).mockResolvedValue([] as never);
    const running = await (await getGame("?seat=0&token=seat-token-1")).json();
    expect(running.quizResult).toBeNull();

    vi.mocked(db.game.findUnique).mockResolvedValue(
      runningGame({ state: { phase: "ENDED", quizResult: { perSeat: {}, perQuestion: [] } } }) as never
    );
    const ended = await (await getGame("?seat=0&token=seat-token-1")).json();
    expect(ended.quizResult).toEqual({ perSeat: {}, perQuestion: [] });
  });

  it("快照与剧本全部损坏 → 503", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(
      runningGame({ scriptSnapshot: { broken: true }, script: { content: { broken: true } } }) as never
    );
    const res = await getGame();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("损坏") });
  });

  it.fails("BUG-01（S3.3 修复）：注释称 header 优先，实际 query 优先", async () => {
    vi.mocked(db.game.findUnique).mockResolvedValue(runningGame() as never);
    vi.mocked(db.seatState.findMany).mockResolvedValue([] as never);
    // header 给对、query 给错：按注释语义应认证成功；当前实现 query 优先 → 认证失败
    const { GET } = await import("./route");
    const res = await GET(
      makeReq("GET", `/api/games/${ID}?seat=0&token=wrong`, { headers: { "x-seat-token": "seat-token-1" } }),
      ctx({ id: ID })
    );
    const body = await res.json();
    expect(body.mySeat).toBe(0); // 当前代码失败（mySeat=null），it.fails 预期内
  });
});
