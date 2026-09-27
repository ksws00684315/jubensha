import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_ID, acquireLease, heldLeaseCount, leaseOwner, releaseAllLeases, releaseLease, renewLease, startLeaseRenewal } from "./lease";

/**
 * S4.1 单写者租约的 L1：只验状态机（获得 / 续租 / 丢失 / 释放）与心跳节奏。
 * `@/lib/db` 换成一张内存表，按 Prisma 的 where 语义做 CAS——
 * 「真库里两个实例抢同一局」归 L3（I08 / I09）。
 */
interface Row {
  id: string;
  ownerId: string | null;
  leaseUntil: Date | null;
}

const store = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  /** 每次 updateMany 记一笔，用于数续租次数 */
  writes: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    game: {
      updateMany: ({ where, data }: { where: { id?: string; ownerId?: string | null; OR?: unknown[] }; data: Partial<Row> }) => {
        // 有 id = 单行 CAS；没有 id = 按 ownerId 批量（releaseAllLeases 的退出清理）
        const candidates = where.id === undefined ? [...store.rows.values()] : [store.rows.get(where.id)];
        const match = (row: Row, clause: Record<string, unknown>) => {
          if ("ownerId" in clause) return row.ownerId === clause.ownerId;
          const lt = (clause.leaseUntil as { lt: Date } | undefined)?.lt;
          return lt !== undefined && row.leaseUntil !== null && row.leaseUntil < lt;
        };
        let count = 0;
        for (const row of candidates) {
          if (!row) continue;
          // OR 分支 = 无人持有 / 已过期 / 本来就是自己；裸 ownerId = 只有持有者能续或放。
          const allowed = where.OR ? where.OR.some((clause) => match(row, clause as Record<string, unknown>)) : row.ownerId === where.ownerId;
          if (!allowed) continue;
          if ("ownerId" in data) row.ownerId = data.ownerId ?? null;
          if ("leaseUntil" in data) row.leaseUntil = data.leaseUntil ?? null;
          store.writes.push(row.id);
          count += 1;
        }
        return { count };
      },
      findUnique: ({ where }: { where: { id: string } }) => store.rows.get(where.id) ?? null,
    },
  },
}));

const GAME = "g1";
const OTHER = "instance-其他";
const T = (iso: string) => new Date(iso).getTime();

function seed(ownerId: string | null = null, leaseUntil: Date | null = null): Row {
  const row: Row = { id: GAME, ownerId, leaseUntil };
  store.rows.set(GAME, row);
  return row;
}

beforeEach(() => {
  store.rows.clear();
  store.writes.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
});

afterEach(async () => {
  // 收掉本步挂上的续租心跳，避免跨用例互相干扰
  await releaseAllLeases();
  vi.useRealTimers();
});

describe("取得租约", () => {
  it("无人持有的对局可以取得，租期按 TTL 到期", async () => {
    const row = seed();
    expect(await acquireLease(GAME, "A")).toBe(true);
    expect(row.ownerId).toBe("A");
    expect(row.leaseUntil?.getTime()).toBe(T("2026-09-27T12:00:30.000Z"));
  });

  it("同一实例重复取得是可重入：只顺延租期，不算失败", async () => {
    const row = seed("A", new Date("2026-09-27T12:00:20.000Z"));
    expect(await acquireLease(GAME, "A")).toBe(true);
    expect(row.ownerId).toBe("A");
    expect(row.leaseUntil?.getTime()).toBe(T("2026-09-27T12:00:30.000Z"));
  });

  it("他人持有且未过期时取不到，也不会改写对方的租约", async () => {
    const row = seed("A", new Date("2026-09-27T12:00:25.000Z"));
    expect(await acquireLease(GAME, "B")).toBe(false);
    expect(row.ownerId).toBe("A");
    expect(row.leaseUntil?.getTime()).toBe(T("2026-09-27T12:00:25.000Z"));
    expect(store.writes).toEqual([]);
  });

  it("租约过期后他人可以接管", async () => {
    const row = seed("A", new Date("2026-09-27T11:59:59.000Z"));
    expect(await acquireLease(GAME, "B")).toBe(true);
    expect(row.ownerId).toBe("B");
  });
});

describe("续租与失效判定", () => {
  it("持有者续租把租期往后推；非持有者续租失败且不动别人的行", async () => {
    const row = seed("A", new Date("2026-09-27T12:00:15.000Z"));
    expect(await renewLease(GAME, "A")).toBe(true);
    expect(row.leaseUntil?.getTime()).toBe(T("2026-09-27T12:00:30.000Z"));
    expect(await renewLease(GAME, OTHER)).toBe(false);
    expect(row.ownerId).toBe("A");
    expect(store.writes).toHaveLength(1);
  });

  it("被接管之后原持有者续租必然失败——这就是「失去租约」的信号", async () => {
    const row = seed("A", new Date("2026-09-27T11:59:59.000Z"));
    expect(await acquireLease(GAME, OTHER)).toBe(true);
    expect(await renewLease(GAME, "A")).toBe(false);
    expect(row.ownerId).toBe(OTHER);
  });

  it("leaseOwner 只在租约真的有效时才认为有人主持", async () => {
    seed(null);
    expect(await leaseOwner(GAME)).toBeNull();
    const row = seed("A", new Date("2026-09-27T12:00:20.000Z"));
    expect(await leaseOwner(GAME)).toBe("A");
    vi.setSystemTime(new Date("2026-09-27T12:00:25.000Z"));
    // 行里还写着 A，但时刻已过期：不能据此让后来者空等
    expect(await leaseOwner(GAME)).toBeNull();
    expect(row.leaseUntil?.getTime()).toBe(T("2026-09-27T12:00:20.000Z"));
  });
});

describe("释放", () => {
  it("释放只清自己的牌；放到别人身上是空操作", async () => {
    const row = seed("A");
    await releaseLease(GAME, OTHER);
    expect(row.ownerId).toBe("A");
    await releaseLease(GAME, "A");
    expect(row.ownerId).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(await acquireLease(GAME, OTHER)).toBe(true);
  });

  it("releaseAllLeases 一条语句收走本实例全部租约，并停掉所有续租心跳", async () => {
    const a: Row = { id: "g-a", ownerId: INSTANCE_ID, leaseUntil: null };
    const b: Row = { id: "g-b", ownerId: INSTANCE_ID, leaseUntil: null };
    const theirs: Row = { id: "g-theirs", ownerId: OTHER, leaseUntil: null };
    for (const row of [a, b, theirs]) store.rows.set(row.id, row);
    startLeaseRenewal(a.id, () => undefined);
    startLeaseRenewal(b.id, () => undefined);
    expect(heldLeaseCount()).toBe(2);
    expect(await releaseAllLeases()).toBe(2);
    expect(heldLeaseCount()).toBe(0);
    expect(a.ownerId).toBeNull();
    expect(b.ownerId).toBeNull();
    // 不是本实例持有的牌不会被收走
    expect(theirs.ownerId).toBe(OTHER);
  });
});

describe("续租心跳", () => {
  it("10s 一跳：30s 内写 3 次，租约始终有效", async () => {
    const row = seed(INSTANCE_ID, new Date("2026-09-27T12:00:30.000Z"));
    const onLost = vi.fn();
    startLeaseRenewal(GAME, onLost);
    expect(heldLeaseCount()).toBe(1);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(store.writes).toHaveLength(3);
    expect(row.ownerId).toBe(INSTANCE_ID);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("被抢走后 onLost 恰好一次，心跳随之停掉（此后不再写别人的行）", async () => {
    const row = seed(INSTANCE_ID, new Date("2026-09-27T12:00:30.000Z"));
    const onLost = vi.fn();
    startLeaseRenewal(GAME, onLost);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(heldLeaseCount()).toBe(1);
    // 模拟另一实例在本实例租约过期后接管
    row.ownerId = OTHER;
    row.leaseUntil = new Date("2026-09-27T12:01:00.000Z");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(heldLeaseCount()).toBe(0);
    const stolenUntil = row.leaseUntil.getTime();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(row.leaseUntil?.getTime()).toBe(stolenUntil);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("同一局重复挂心跳只保留一个定时器", async () => {
    seed(INSTANCE_ID);
    const onLost = vi.fn();
    startLeaseRenewal(GAME, onLost);
    startLeaseRenewal(GAME, onLost);
    expect(heldLeaseCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.writes).toHaveLength(1);
  });
});
