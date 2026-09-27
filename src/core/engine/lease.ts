import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * 单写者租约（S4.1）：同一局在任一时刻最多只有一个进程在驱动。
 *
 * 多实例（或同一实例的重复加载）同时跑同一局时，双方都会发 AI 回合、都会 `persist()`，
 * 结果是重复发言与快照互相覆盖。这里用 `games.ownerId` / `games.leaseUntil` 两列做 CAS
 * 取写权：**拿到租约才驱动，拿不到就只读**。
 *
 * 为什么不用 `pg_advisory_lock`：Prisma 走连接池，加锁与解锁可能落在不同连接上，
 * 会话级锁因此不可靠（计划 §1.1）。
 *
 * ## 时序
 * - 租期 30s，续租间隔 10s：租期是间隔的 3 倍，事件循环被一个长任务卡住也不会丢租约。
 * - 续租返回 `count === 0` 即「已失去租约」——持有者必须立刻停止写入，
 *   调用方注册的 `onLost` 负责停定时器、中止在途生成、把自己移出常驻表。
 * - 崩溃 / 未走 `SIGTERM` 的进程不释放租约，靠 30s TTL 自然过期后由别人接管。
 */

/**
 * 进程级实例 id。放在 globalThis 上是因为 dev 热重载会重新求值本模块：
 * 若每次重载换一个新 id，重载后的服务会把自己上一份引擎的租约当成别人的，
 * 从而在 30s 内只对局只读。与 `registry.ts` / `bus.ts` 的常驻表同一套做法。
 */
declare global {
  var __jbsLeaseInstanceId: string | undefined;
  /** gameId → 续租定时器 */
  var __jbsLeaseRenewals: Map<string, NodeJS.Timeout> | undefined;
  /** SIGTERM 交牌钩子只挂一次（服务端 bundles 会把本模块打进多个 chunk） */
  var __jbsLeaseSignalInstalled: boolean | undefined;
}

export const INSTANCE_ID: string = (globalThis.__jbsLeaseInstanceId ??= randomUUID());

/** 租期：最后一次成功续租后 30 秒内无人认领即视为失效 */
export const LEASE_TTL_MS = 30_000;
/** 续租间隔：租期的 1/3，留两个周期的容错 */
export const LEASE_RENEW_INTERVAL_MS = 10_000;

/** 未持有租约时触碰写出口的错误。只进服务日志，不作为玩家可见文案（不变式 5）。 */
export class LeaseLostError extends Error {
  constructor(gameId: string) {
    super(`对局 ${gameId} 的写租约不在本实例`);
    this.name = "LeaseLostError";
  }
}

const renewals: Map<string, NodeJS.Timeout> = (globalThis.__jbsLeaseRenewals ??= new Map());

/**
 * 尝试取得写租约。可重入：同一实例重复取得只会顺延租期。
 * 三种前态都可取得——无人持有、租约已过期、本来就归自己。
 */
export async function acquireLease(gameId: string, ownerId: string = INSTANCE_ID): Promise<boolean> {
  const now = new Date();
  const res = await db.game.updateMany({
    where: {
      id: gameId,
      OR: [{ ownerId: null }, { leaseUntil: { lt: now } }, { ownerId }],
    },
    data: { ownerId, leaseUntil: new Date(now.getTime() + LEASE_TTL_MS) },
  });
  return res.count === 1;
}

/** 续租。`false` = 这一局已不归本实例主持，调用方须立即停止写入。 */
export async function renewLease(gameId: string, ownerId: string = INSTANCE_ID): Promise<boolean> {
  const res = await db.game.updateMany({
    where: { id: gameId, ownerId },
    data: { leaseUntil: new Date(Date.now() + LEASE_TTL_MS) },
  });
  return res.count === 1;
}

/** 主动释放（终局驱逐、进程退出）。不是自己的租约不会被动。 */
export async function releaseLease(gameId: string, ownerId: string = INSTANCE_ID): Promise<void> {
  stopLeaseRenewal(gameId);
  await db.game.updateMany({
    where: { id: gameId, ownerId },
    data: { ownerId: null, leaseUntil: null },
  });
}

/** 当前有效持有人 id；无人持有或已过期都返回 `null`。用于「为什么我是只读」的日志。 */
export async function leaseOwner(gameId: string): Promise<string | null> {
  const row = await db.game.findUnique({ where: { id: gameId }, select: { ownerId: true, leaseUntil: true } });
  if (!row?.ownerId) return null;
  if (row.leaseUntil && row.leaseUntil.getTime() <= Date.now()) return null;
  return row.ownerId;
}

/**
 * 挂上续租心跳（定时器 `unref`，不会拖住进程退出）。
 * 同一局重复调用按 gameId 去重：只保留最后一个。
 */
export function startLeaseRenewal(gameId: string, onLost: () => void, ownerId: string = INSTANCE_ID): void {
  stopLeaseRenewal(gameId);
  const timer = setInterval(() => {
    void renewLease(gameId, ownerId)
      .then((held) => {
        if (held) return;
        stopLeaseRenewal(gameId);
        onLost();
      })
      .catch(() => {
        // 数据库瞬时故障不算「被接管」：留着定时器下一轮再试；真被抢走时续租会以 count=0 返回。
      });
  }, LEASE_RENEW_INTERVAL_MS);
  timer.unref?.();
  renewals.set(gameId, timer);
}

export function stopLeaseRenewal(gameId: string): void {
  const timer = renewals.get(gameId);
  if (timer) {
    clearInterval(timer);
    renewals.delete(gameId);
  }
}

/** 本实例当前持有租约的对局数（S6 的健康看板要用）。 */
export function heldLeaseCount(): number {
  return renewals.size;
}

/** 一条 UPDATE 释放本实例持有的全部租约；返回受影响行数。 */
export async function releaseAllLeases(): Promise<number> {
  for (const gameId of [...renewals.keys()]) stopLeaseRenewal(gameId);
  const res = await db.game.updateMany({
    where: { ownerId: INSTANCE_ID },
    data: { ownerId: null, leaseUntil: null },
  });
  return res.count;
}

/**
 * `SIGTERM` → 先放租约再退出，避免接管方等满 30s TTL。
 * 只处理 SIGTERM：`next dev` 的 Ctrl-C 走 SIGINT，那条路径交给 TTL 自然过期，
 * 不在开发热重载里抢退出时序。
 */
export function installLeaseReleaseOnSignal(): void {
  if (globalThis.__jbsLeaseSignalInstalled) return;
  globalThis.__jbsLeaseSignalInstalled = true;
  // prependListener：Next 自己也挂了 SIGTERM 处理器做优雅退出（start-server.ts），
  // 它会先注册。放牌必须在它之前起头，否则两边抢同一次优雅退出的时间窗。
  process.prependOnceListener("SIGTERM", () => {
    log.info("[lease] SIGTERM：交回写租约", { leaseCount: renewals.size, instanceId: INSTANCE_ID.slice(0, 8) });
    void releaseAllLeases()
      .catch((err: unknown) => {
        log.warn("[lease] 退出前释放租约失败", { error: err });
      })
      .finally(() => {
        process.exit(0);
      });
  });
}
