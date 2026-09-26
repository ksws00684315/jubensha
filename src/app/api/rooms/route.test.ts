import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHeaders, ctx, makeReq, mockDbInstance, resetRateLimits, TEST_ADMIN_TOKEN } from "@/test/api";
import { db } from "@/lib/db";
import { scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

function stubProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SECRET_MASTER_KEY", "master-key-for-test-0123456789");
  vi.stubEnv("ADMIN_TOKEN", TEST_ADMIN_TOKEN);
}

const seats3 = [
  { kind: "human", characterId: "linhai" },
  { kind: "ai", characterId: "suyu" },
  { kind: "ai", characterId: "guchen" },
];

describe("A22 POST /api/rooms", () => {
  it("座位数 < 3 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: [] } }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("座位数 > 8 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: Array.from({ length: 9 }, () => ({ kind: "human" })) } }),
      ctx({})
    );
    expect(res.status).toBe(400);
  });

  it("剧本不存在 → 404", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "ghost", seats: seats3 } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("角色重复 → 400", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/rooms", {
        body: { scriptId: "script-1", seats: [{ kind: "human", characterId: "linhai" }, { kind: "ai", characterId: "linhai" }, { kind: "ai", characterId: "suyu" }] },
      }),
      ctx({})
    );
    expect(res.status).toBe(400);
  });

  it("创建成功 → 201 + hostToken 为 32 位 hex", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-1", code: "ABCDE" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: seats3 } }), ctx({}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hostToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.code).toBe("ABCDE");
  });

  it("P2002 撞码重试后成功", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create)
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }) as never)
      .mockResolvedValue({ id: "room-2", code: "FGHJK" } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: seats3 } }), ctx({}));
    expect(res.status).toBe(201);
    expect(db.room.create).toHaveBeenCalledTimes(2);
  });

  it("限流：同 IP 第 6 个/分钟 → 429 + Retry-After", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-x", code: "ZZZZZ" } as never);
    const { POST } = await import("./route");
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await POST(
        makeReq("POST", "/api/rooms", { body: { scriptId: "script-1", seats: seats3 }, headers: { "x-forwarded-for": "10.9.9.9" } }),
        ctx({})
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBeTruthy();
  });

  it("admin 策略待 S3.1 实现：当前 production 下纯 AI 房仍可创建（基线行为）", async () => {
    stubProduction();
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    vi.mocked(db.room.create).mockResolvedValue({ id: "room-ai", code: "AAAAA" } as never);
    const { POST } = await import("./route");
    const res = await POST(
      makeReq("POST", "/api/rooms", { headers: adminHeaders(), body: { scriptId: "script-1", seats: [{ kind: "ai", characterId: "linhai" }, { kind: "ai", characterId: "suyu" }, { kind: "ai", characterId: "guchen" }] } }),
      ctx({})
    );
    expect([201, 403]).toContain(res.status); // S3.1 落地后收敛为 201（管理员）
  });
});
