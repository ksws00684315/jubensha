import { beforeEach, describe, expect, it } from "vitest";
import { clientIp, rateLimit, resetRateLimits, checkJoinRateLimit } from "./rate-limit";

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("窗口内放行 limit 次，第 limit+1 次拒绝并给出重试时间", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("k", 3, 1000, now).ok).toBe(true);
    }
    const blocked = rateLimit("k", 3, 1000, now);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
  });

  it("窗口滚过后重新放行", () => {
    expect(rateLimit("k", 1, 1000, 0).ok).toBe(true);
    expect(rateLimit("k", 1, 1000, 500).ok).toBe(false);
    expect(rateLimit("k", 1, 1000, 1000).ok).toBe(true);
  });

  it("不同 key 互不影响", () => {
    expect(rateLimit("a", 1, 1000, 0).ok).toBe(true);
    expect(rateLimit("b", 1, 1000, 0).ok).toBe(true);
    expect(rateLimit("a", 1, 1000, 0).ok).toBe(false);
  });
});

describe("clientIp", () => {
  it("取 XFF 首跳，其次 x-real-ip，都缺省归为 unknown", () => {
    expect(clientIp(new Request("http://x/api", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe("1.2.3.4");
    expect(clientIp(new Request("http://x/api", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientIp(new Request("http://x/api"))).toBe("unknown");
  });
});

describe("checkJoinRateLimit", () => {
  const req = (ip: string) => new Request("http://x/api/rooms/join", { headers: { "x-forwarded-for": ip } });

  it("同一 IP 超过每分钟配额后被拒", () => {
    for (let i = 0; i < 10; i++) expect(checkJoinRateLimit(req("1.1.1.1")).ok).toBe(true);
    const blocked = checkJoinRateLimit(req("1.1.1.1"));
    expect(blocked.ok).toBe(false);
  });

  it("换个 IP 仍有独立配额（全局桶未打满时）", () => {
    for (let i = 0; i < 10; i++) checkJoinRateLimit(req("1.1.1.1"));
    expect(checkJoinRateLimit(req("2.2.2.2")).ok).toBe(true);
  });
});
