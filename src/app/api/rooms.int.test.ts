import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq } from "@/test/api";
import { LLM_LINE, seedScript, seats1h2a, setupIntEnv, truncateAll } from "@/test/int";
import { db } from "@/lib/db";
import { engines, engineLoads } from "@/core/engine/registry";

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
afterEach(() => {
  // 清掉常驻引擎定时器，避免挂起测试进程
  for (const e of engines.values()) e.clearTimers();
  engines.clear();
  engineLoads.clear();
  vi.useRealTimers();
});

describe("L3：房间全链路（真库）", () => {
  it("I01 建房 → join → start 全链路：行数与快照正确", async () => {
    vi.useFakeTimers();
    const script = await seedScript();
    const { POST: createRoom } = await import("./rooms/route");
    const createRes = await createRoom(makeReq("POST", "/api/rooms", { body: { scriptId: script.id, seats: seats1h2a() } }), ctx({}));
    expect(createRes.status).toBe(201);
    const { code, hostToken } = (await createRes.json()) as { code: string; hostToken: string };

    const { POST: join } = await import("./rooms/join/route");
    const joinRes = await join(makeReq("POST", "/api/rooms/join", { body: { code, name: "真人大佬" } }), ctx({}));
    expect(joinRes.status).toBe(200);

    const { POST: start } = await import("./rooms/[code]/start/route");
    const startRes = await start(makeReq("POST", `/api/rooms/${code}/start`, { body: { hostToken } }), ctx({ code }));
    expect(startRes.status).toBe(201);
    const { gameId } = (await startRes.json()) as { gameId: string };

    const room = await db.room.findUnique({ where: { code }, include: { seats: true } });
    const game = await db.game.findUnique({ where: { id: gameId }, include: { seatStates: true, events: true } });
    expect(room?.status).toBe("playing");
    expect(room?.seats).toHaveLength(3);
    expect(room?.seats.filter((s) => s.kind === "human" && s.token)).toHaveLength(1);
    expect(game?.status).toBe("running");
    expect(game?.phase).toBe("READING");
    expect(game?.seatStates).toHaveLength(3);
    expect(game?.scriptHash).toMatch(/^[0-9a-f]{64}$/);
    // 快照与 hash 一致（jsonb 不保序，先按运行时解析规范化再算）
    const { parseScriptForRuntime } = await import("@/core/script/compat");
    const { createHash } = await import("node:crypto");
    const normalized = parseScriptForRuntime(game?.scriptSnapshot);
    const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    expect(hash).toBe(game?.scriptHash);
  }, 30_000);

  it("I02 同一房间并发两次 start：恰好 1 个成功", async () => {
    vi.useFakeTimers();
    const script = await seedScript();
    const { POST: createRoom } = await import("./rooms/route");
    const createRes = await createRoom(makeReq("POST", "/api/rooms", { body: { scriptId: script.id, seats: seats1h2a() } }), ctx({}));
    const { code, hostToken } = (await createRes.json()) as { code: string; hostToken: string };
    const { POST: join } = await import("./rooms/join/route");
    await join(makeReq("POST", "/api/rooms/join", { body: { code, name: "真人大佬" } }), ctx({}));

    const { POST: start } = await import("./rooms/[code]/start/route");
    const [a, b] = await Promise.all([
      start(makeReq("POST", `/api/rooms/${code}/start`, { body: { hostToken } }), ctx({ code })),
      start(makeReq("POST", `/api/rooms/${code}/start`, { body: { hostToken } }), ctx({ code })),
    ]);
    const statuses = [a.status, b.status].sort();
    // 并发失败方要么撞roomId唯一约束(409)、要么先查到已有对局(400)
    expect(statuses).toEqual([201, 409]);
    const games = await db.game.findMany({ where: { room: { code } } });
    expect(games).toHaveLength(1);
  }, 30_000);

  it("I03 并发两人抢最后一个真人座位：恰好 1 人成功", async () => {
    vi.useFakeTimers();
    const script = await seedScript();
    const { POST: createRoom } = await import("./rooms/route");
    const createRes = await createRoom(
      makeReq("POST", "/api/rooms", { body: { scriptId: script.id, seats: [{ kind: "empty", characterId: null }, { kind: "human" }, { kind: "human" }] } }),
      ctx({})
    );
    const { code } = (await createRes.json()) as { code: string };
    // 先占一个真人座
    const { POST: join } = await import("./rooms/join/route");
    const first = await join(makeReq("POST", "/api/rooms/join", { body: { code, name: "甲" } }), ctx({}));
    expect(first.status).toBe(200);

    const [a, b] = await Promise.all([
      join(makeReq("POST", "/api/rooms/join", { body: { code, name: "乙" } }), ctx({})),
      join(makeReq("POST", "/api/rooms/join", { body: { code, name: "丙" } }), ctx({})),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const seats = await db.seat.findMany({ where: { room: { code } } });
    const tokened = seats.filter((s) => s.token);
    expect(tokened).toHaveLength(2); // 甲 + 恰好一个并发赢家
  }, 30_000);

  it("I04 房间码撞码（P2002）重试后成功且 code 不同", async () => {
    vi.useFakeTimers();
    const script = await seedScript();
    const { POST: createRoom } = await import("./rooms/route");
    // 让第一次 create 抛 P2002（模拟撞码），重试走真实创建
    const original = db.room.create.bind(db.room);
    const spy = vi
      .spyOn(db.room, "create")
      .mockImplementationOnce((async () => {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }) as never)
      .mockImplementationOnce(((args: unknown) => original(args as never)) as never);
    const res = await createRoom(makeReq("POST", "/api/rooms", { body: { scriptId: script.id, seats: seats1h2a() } }), ctx({}));
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    const rooms = await db.room.findMany();
    expect(rooms).toHaveLength(1);
    expect(rooms[0].code).toMatch(/^[A-Z0-9]{5}$/);
  }, 30_000);
});
