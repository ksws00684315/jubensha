import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { roomRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

describe("A27 POST /api/rooms/dm-join", () => {
  it("参数不合法 → 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "A" } }), ctx({}));
    expect(res.status).toBe(400);
  });

  it("房间不存在 → 404", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(null as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "ZZZZZ", name: "主持" } }), ctx({}));
    expect(res.status).toBe(404);
  });

  it("非 humanDm 房 → 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(roomRow({ humanDm: false }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "ABCDE", name: "主持" } }), ctx({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("真人 DM") });
  });

  it("已被认领（非本人）→ taken 403", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(roomRow({ humanDm: true, dmToken: "dm-taken", dmName: "别人" }) as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "ABCDE", name: "主持" } }), ctx({}));
    expect(res.status).toBe(403);
  });

  it("凭旧 token 恢复 → resume 并换发新 token", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(roomRow({ humanDm: true, dmToken: "dm-old", dmName: "主持" }) as never);
    vi.mocked(db.room.update).mockResolvedValue(roomRow() as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "ABCDE", name: "主持", token: "dm-old" } }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("首次认领 → updateMany 原子占位成功", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(roomRow({ humanDm: true, dmToken: null, dmName: null }) as never);
    vi.mocked(db.room.updateMany).mockResolvedValue({ count: 1 } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "ABCDE", name: "主持" } }), ctx({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resumed).toBe(false);
    expect(db.room.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ dmToken: null, humanDm: true }) })
    );
  });

  it("并发抢 DM：updateMany count=0 → 400", async () => {
    vi.mocked(db.room.findUnique).mockResolvedValue(roomRow({ humanDm: true, dmToken: null, dmName: null }) as never);
    vi.mocked(db.room.updateMany).mockResolvedValue({ count: 0 } as never);
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", "/api/rooms/dm-join", { body: { code: "ABCDE", name: "主持" } }), ctx({}));
    expect(res.status).toBe(400);
  });
});
