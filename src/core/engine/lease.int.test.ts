import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { LLM_LINE, seedScript, seats1h2a, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";
import { db } from "@/lib/db";
import { GameEngine } from "./engine";
import { engines } from "./registry";
import { INSTANCE_ID, LeaseLostError, acquireLease, leaseOwner, releaseLease, renewLease } from "./lease";

/**
 * L3 单写者租约（S4.1）。与 L1 的分工：L1 用内存表验状态机与心跳节奏，
 * 这里验真 Postgres 上的 CAS 竞争结果、接管后的事件流形态，以及真子进程的 SIGTERM 交牌。
 *
 * 「另一实例」在同一进程里用 `ownerId: OTHER` 模拟（`GameEngine.load` 的第二个参数只为测试存在）；
 * 唯一必须真起进程的是 SIGTERM 那条——信号处理只有跨进程才可信。
 */

const OTHER = "instance-b-simulated";

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

async function startGame(code: string): Promise<string> {
  const script = await seedScript();
  const scriptRow = await db.script.findUnique({ where: { id: script.id } });
  const room = await db.room.create({
    data: {
      code,
      scriptId: script.id,
      status: "lobby",
      hostToken: "host-token-1",
      seats: {
        create: seats1h2a().map((s, index) => ({
          index,
          kind: s.kind,
          characterId: s.characterId,
          playerName: s.kind === "human" ? "真人大佬" : null,
          token: s.kind === "human" ? "seat-token-1" : null,
        })),
      },
    },
    include: { seats: true },
  });
  const engine = await GameEngine.start(room as never, { id: script.id, content: scriptRow!.content });
  engine.clearTimers(); // 开场旁白等后台定时器会持续往事件流追加内容，干扰计数型断言
  return engine.gameId;
}

async function eventCount(gameId: string): Promise<number> {
  return db.gameEvent.count({ where: { gameId } });
}

/** 把租约推到已过期，等价于「持有者停止续租并超过 TTL」，但不必真的等 30s。 */
async function expireLease(gameId: string): Promise<void> {
  await db.game.update({ where: { id: gameId }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("L3：单写者租约（I08）", () => {
  it("两个 owner 加载同一局：只有取到牌的那个驱动，另一个全程不写库", async () => {
    const gameId = await startGame("LSE08");
    const holder = await GameEngine.load(gameId);
    expect(holder.drive).toBe(true);
    expect(await leaseOwner(gameId)).toBe(INSTANCE_ID);

    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((msg: unknown) => {
      warns.push(String(msg));
    });
    const other = await GameEngine.load(gameId, { ownerId: OTHER });
    spy.mockRestore();

    expect(other.drive).toBe(false);
    expect(other.ownerId).toBe(OTHER);
    // 只读视图不进常驻表：否则持牌者放牌后，本实例会一直复用这个只读实例而再也接管不了
    expect(engines.get(gameId)).toBe(holder);
    // R5 的判据要在实例日志里 grep 到这一句
    expect(warns.some((w) => w.includes("lease held by"))).toBe(true);

    const before = await eventCount(gameId);
    const stateBefore = (await db.game.findUnique({ where: { id: gameId }, select: { state: true } }))!.state;
    expect(await other.handleAction(0, { type: "ready" } as never)).toEqual({ ok: false, error: "对局由其他实例主持，请刷新" });
    await expect(other.persist()).rejects.toBeInstanceOf(LeaseLostError);
    other.schedule("probe", () => undefined, 1);
    expect(other.timers.size).toBe(0);
    expect(await eventCount(gameId)).toBe(before);
    expect((await db.game.findUnique({ where: { id: gameId }, select: { state: true } }))!.state).toEqual(stateBefore);
    expect(await leaseOwner(gameId)).toBe(INSTANCE_ID); // 牌还在持牌者手上
  });

  it("同一 owner 重复加载复用常驻引擎，可重入取牌不换主人", async () => {
    const gameId = await startGame("LSE08B");
    const first = await GameEngine.load(gameId);
    expect(await GameEngine.load(gameId)).toBe(first);
    expect(await acquireLease(gameId)).toBe(true);
    expect(await leaseOwner(gameId)).toBe(INSTANCE_ID);
  });

  it("持牌者被抢牌后：续租返回 false，停写后事件流不再增长", async () => {
    const gameId = await startGame("LSE08C");
    const holder = await GameEngine.load(gameId);
    // 只过期不算被抢：过期但 ownerId 仍是自己时续租会成功（这是租约列方案的正确语义）
    await expireLease(gameId);
    expect(await acquireLease(gameId, OTHER)).toBe(true);
    expect(await renewLease(gameId)).toBe(false); // 心跳据此判定丢牌（L1 已验心跳会调 onLeaseLost）
    holder.onLeaseLost();
    expect(holder.drive).toBe(false);
    const before = await eventCount(gameId);
    expect((await holder.handleAction(0, { type: "ready" } as never)).ok).toBe(false);
    await expect(holder.persist()).rejects.toBeInstanceOf(LeaseLostError);
    expect(await eventCount(gameId)).toBe(before);
  });
});

describe("L3：租约过期接管（I09）", () => {
  it("持有者停止续租 → 过期 → 另一实例接管，seq 连续且无重复发言", async () => {
    const gameId = await startGame("LSE09");
    const holder = await GameEngine.load(gameId);
    expect((await holder.handleAction(0, { type: "ready" } as never)).ok).toBe(true);
    await expireLease(gameId);

    const taken = await GameEngine.load(gameId, { ownerId: OTHER });
    expect(taken.drive).toBe(true);
    expect(await leaseOwner(gameId)).toBe(OTHER);
    expect(engines.get(gameId)).toBe(taken);

    // 旧持有者被告知丢牌后写入一律被拦下，不会把接管方的现场写花
    holder.onLeaseLost();
    const before = await eventCount(gameId);
    expect((await holder.handleAction(0, { type: "ready" } as never)).ok).toBe(false);
    expect(await eventCount(gameId)).toBe(before);

    expect((await taken.handleAction(0, { type: "ready" } as never)).ok).toBe(true);
    const state = (await db.game.findUnique({ where: { id: gameId }, select: { state: true } }))!.state as { readySeats: number[] };
    expect(state.readySeats.filter((s) => s === 0)).toEqual([0]); // 幂等：接管方不重复追加

    const seqs = (await db.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" }, select: { seq: true } })).map((r) => Number(r.seq));
    expect(seqs.length).toBe(await eventCount(gameId));
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i)); // 连续、无重复、无空洞
    const speeches = await db.gameEvent.groupBy({
      by: ["type", "fromSeat", "round"],
      where: { gameId, type: "speech" },
      _count: { seq: true },
    });
    expect(speeches.every((g) => g._count.seq === 1)).toBe(true);
  }, 60_000);
});

/**
 * 拉起一个持牌子进程（真·另一实例），发信号，返回交牌耗时与退出码。
 * 用 `node --import tsx` 而不是 `node_modules/.bin/tsx`：后者会再 fork 一个包装进程，
 * 交牌判据要打在真正跑脚本的进程上。
 */
async function signalHolder(code: string, signal: NodeJS.Signals, extraEnv: Record<string, string> = {}) {
  const gameId = await startGame(code);
  await releaseLease(gameId); // 本实例退出驱动，把牌让给子进程
  expect(await leaseOwner(gameId)).toBeNull();

  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "test", "lease-holder-child.ts"), gameId], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 退出事件必须在发信号之前就挂上：`exit` 不会补发，晚挂就再也等不到（子进程 50ms 内退了）。
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    child.once("exit", (exitCode, exitSignal) => r({ code: exitCode, signal: exitSignal }));
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });

  const t0 = Date.now();
  while (!out.includes("READY")) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`子进程提前退出（code=${child.exitCode}）：${out}|${err}`);
    if (Date.now() - t0 > 60_000) throw new Error(`子进程 60s 内未就绪：${out}|${err}`);
    await sleep(100);
  }
  expect(out).toContain("ACQUIRED true"); // 真取到了牌，才谈得上「交牌」
  expect(out).toContain("HOLDER ");

  const owner = await leaseOwner(gameId);
  expect(owner).not.toBeNull();
  expect(owner).not.toBe(INSTANCE_ID); // 牌在另一个进程手上

  const t1 = Date.now();
  child.kill(signal);
  const finished = await Promise.race([exited, sleep(10_000).then(() => null)]);
  if (!finished) throw new Error(`${signal} 后 10s 内子进程未退出`);
  // 进程已退出：此刻还没交牌，就只能等 30s TTL 过期了
  const releasedBeforeExit = (await leaseOwner(gameId)) === null;
  return { releasedBeforeExit, elapsed: Date.now() - t1, exitCode: finished.code };
}

describe("L3：退出信号交牌（验收 4）", () => {
  it("子进程（真·另一实例）收到 SIGTERM 后 1s 内释放租约", async () => {
    const r = await signalHolder("LSE10", "SIGTERM");
    expect(r.releasedBeforeExit).toBe(true);
    expect(r.elapsed).toBeLessThan(1_000);
    expect(r.exitCode).toBe(0);
  }, 90_000);

  it("与 Next 的退出处理器并存时，先交牌再交给它退出（SIGTERM）", async () => {
    const r = await signalHolder("LSE11", "SIGTERM", { LEASE_CHILD_COMPETING_EXIT: "1" });
    expect(r.releasedBeforeExit).toBe(true);
    expect(r.elapsed).toBeLessThan(1_000);
    expect(r.exitCode).toBe(143); // Next 的处理器最终照常执行，退出码归它定
  }, 90_000);

  it("生产环境下 pm2 默认的 SIGINT 同样先交牌", async () => {
    const r = await signalHolder("LSE12", "SIGINT", { LEASE_CHILD_COMPETING_EXIT: "1", NODE_ENV: "production" });
    expect(r.releasedBeforeExit).toBe(true);
    expect(r.elapsed).toBeLessThan(1_000);
    expect(r.exitCode).toBe(130);
  }, 90_000);
});
