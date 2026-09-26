import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { scriptRow } from "@/test/fixtures";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

describe("A20 GET /api/scripts/[id]/meta", () => {
  it("不存在 → 404", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(null as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/scripts/s1/meta"), ctx({ id: "s1" }));
    expect(res.status).toBe(404);
  });

  it("返回公开元数据，不含真相/私卡/设计包", async () => {
    vi.mocked(db.script.findFirst).mockResolvedValue(scriptRow() as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/scripts/s1/meta"), ctx({ id: "s1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: "script-1" });
    expect(body.locations).toBeTruthy();
    expect(body.characters.length).toBeGreaterThan(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("truth");
    expect(raw).not.toContain("privateCard");
    expect(raw).not.toContain("designPackage");
    expect(body.characters[0].publicBio).toBeTruthy();
  });
});
