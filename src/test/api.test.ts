import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, dbFn, makeReq, mockDbInstance, resetRateLimits, TEST_ADMIN_TOKEN, type MockDb } from "./api";
import { gameRow, roomRow, scriptRow, seatRow } from "./fixtures";
import { rateLimit } from "@/lib/rate-limit";

describe("test/api 夹具", () => {
  describe("mockDb", () => {
    it("同一 model.method 反复访问返回同一个 vi.fn，可记录调用", () => {
      const a = mockDbInstance.game.findUnique;
      const b = dbFn("game", "findUnique");
      expect(a).toBe(b);
      expect(vi.isMockFunction(a)).toBe(true);
      void mockDbInstance.game.findUnique({ where: { id: "g1" } });
      expect(b).toHaveBeenCalledWith({ where: { id: "g1" } });
    });

    it("不同模型/方法各自独立", () => {
      expect(mockDbInstance.room.findFirst).not.toBe(dbFn("game", "findUnique"));
      expect(mockDbInstance.room.update).not.toBe(dbFn("room", "findFirst"));
    });

    it("$transaction 数组形式按序执行并汇总结果", async () => {
      dbFn("gameEvent", "create").mockResolvedValue({ seq: BigInt(1) });
      dbFn("game", "update").mockResolvedValue({ id: "g1" });
      const tx = mockDbInstance.$transaction as unknown as (arg: unknown[]) => Promise<unknown[]>;
      const out = await tx([mockDbInstance.gameEvent.create(), mockDbInstance.game.update()]);
      expect(out).toEqual([{ seq: BigInt(1) }, { id: "g1" }]);
    });

    it("$transaction 回调形式把 mock db 作为 tx 传入", async () => {
      dbFn("seat", "updateMany").mockResolvedValue({ count: 1 });
      const tx = mockDbInstance.$transaction as unknown as (arg: (t: MockDb) => Promise<unknown>) => Promise<unknown>;
      const out = await tx(async (t: MockDb) => t.seat.updateMany());
      expect(out).toEqual({ count: 1 });
    });

    it("$transaction 拒绝未知参数形态", async () => {
      const tx = mockDbInstance.$transaction as unknown as (arg: unknown) => Promise<unknown>;
      await expect(tx(42)).rejects.toThrow(/unsupported/);
    });
  });

  describe("makeReq / ctx / adminHeaders", () => {
    it("makeReq 生成带 JSON body 与 content-type 的请求", () => {
      const req = makeReq("POST", "/api/rooms", { body: { scriptId: "s1" } });
      expect(req.method).toBe("POST");
      expect(req.headers.get("content-type")).toBe("application/json");
      return req.json().then((j) => expect(j).toEqual({ scriptId: "s1" }));
    });

    it("makeReq 支持 query 与自定义头，URL 保持 http://localhost 源", () => {
      const req = makeReq("GET", "/api/games/g1/events", { query: { lastSeq: 5 }, headers: { "x-test": "1" } });
      expect(req.url).toBe("http://localhost/api/games/g1/events?lastSeq=5");
      expect(req.headers.get("x-test")).toBe("1");
    });

    it("ctx 把 params 包成 Promise，与 Next 16 路由签名一致", async () => {
      const c = ctx({ id: "g1" });
      await expect(c.params).resolves.toEqual({ id: "g1" });
    });

    it("adminHeaders 设置 ADMIN_TOKEN 并返回匹配的请求头", () => {
      const h = adminHeaders();
      expect(h["x-admin-token"]).toBe(TEST_ADMIN_TOKEN);
      expect(process.env.ADMIN_TOKEN).toBe(TEST_ADMIN_TOKEN);
    });
  });

  describe("resetRateLimits", () => {
    beforeEach(() => resetRateLimits());

    it("复位后同一 key 重新计数", () => {
      expect(rateLimit("k", 1, 60_000).ok).toBe(true);
      expect(rateLimit("k", 1, 60_000).ok).toBe(false);
      resetRateLimits();
      expect(rateLimit("k", 1, 60_000).ok).toBe(true);
    });
  });
});

describe("test/fixtures 行工厂", () => {
  it("roomRow 默认大厅房，可覆写", () => {
    const r = roomRow({ status: "playing" });
    expect(r.status).toBe("playing");
    expect(r.hostToken).toBe("host-token-1");
  });

  it("seatRow 默认真人座位，token 存在", () => {
    const s = seatRow();
    expect(s.kind).toBe("human");
    expect(s.token).toBe("seat-token-1");
  });

  it("gameRow 默认 running 对局", () => {
    expect(gameRow().status).toBe("running");
    expect(gameRow().room).toBeUndefined();
  });

  it("scriptRow content 来自仓库示例剧本且可通过 JSON 解析", () => {
    const s = scriptRow();
    expect(s.content).toBeTruthy();
    expect((s.content as { meta?: unknown }).meta).toBeTruthy();
  });
});
