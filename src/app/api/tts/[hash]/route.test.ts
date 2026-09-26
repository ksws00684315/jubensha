import { beforeEach, describe, expect, it, vi } from "vitest";
import { ctx, makeReq, mockDbInstance, resetRateLimits } from "@/test/api";
import { db } from "@/lib/db";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
});

describe("A34 GET /api/tts/[hash]", () => {
  it("hash 非法（含路径穿越）→ 400，不读任意路径", async () => {
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", "/api/tts/..%2F..%2Fetc%2Fpasswd"), ctx({ hash: "../../etc/passwd" }));
    expect(res.status).toBe(400);
    expect(db.ttsCache.findUnique).not.toHaveBeenCalled();
  });

  it("hash 格式对但不存在 → 404", async () => {
    vi.mocked(db.ttsCache.findUnique).mockResolvedValue(null as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/tts/${"b".repeat(32)}`), ctx({ hash: "b".repeat(32) }));
    expect(res.status).toBe(404);
  });

  it("已缓存 → 返回音频流", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tts-"));
    const file = path.join(dir, "a.mp3");
    writeFileSync(file, "fake-mp3-bytes");
    vi.mocked(db.ttsCache.findUnique).mockResolvedValue({ hash: "c".repeat(32), filePath: file } as never);
    try {
      const { GET } = await import("./route");
      const res = await GET(makeReq("GET", `/api/tts/${"c".repeat(32)}`), ctx({ hash: "c".repeat(32) }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/mpeg");
      const text = await res.text();
      expect(text).toContain("fake-mp3-bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // BUG-03：createReadStream 的 ENOENT 是异步错误，try/catch 接不住 → 实际返回 200 后流中断
  it.fails("缓存行在但文件丢失 → 404", async () => {
    vi.mocked(db.ttsCache.findUnique).mockResolvedValue({ hash: "d".repeat(32), filePath: "/nonexistent/a.mp3" } as never);
    const { GET } = await import("./route");
    const res = await GET(makeReq("GET", `/api/tts/${"d".repeat(32)}`), ctx({ hash: "d".repeat(32) }));
    expect(res.status).toBe(404);
  });
});
