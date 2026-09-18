import { describe, expect, it, vi } from "vitest";
import { isAdminSync, safeEqualString } from "./admin";

describe("isAdminSync", () => {
  it("本机 localhost 视为管理员", () => {
    expect(isAdminSync({ host: "localhost:3000" })).toBe(true);
    expect(isAdminSync({ host: "127.0.0.1:3000" })).toBe(true);
  });

  it("局域网 Host 默认不是管理员", () => {
    expect(isAdminSync({ host: "192.168.1.8:3000" })).toBe(false);
  });

  it("伪造的 x-forwarded-for 不能把公网 Host 变成管理员", () => {
    expect(isAdminSync({ host: "example.com", xff: "127.0.0.1" })).toBe(false);
  });

  it("生产环境不信任伪造的 loopback Host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SECRET_MASTER_KEY", "test-secret-master-key");
    vi.stubEnv("ADMIN_TOKEN", "test-admin-token");
    try {
      expect(isAdminSync({ host: "localhost:3000" })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("口令比较不接受不同长度或不同内容", () => {
    expect(safeEqualString("secret", "secret")).toBe(true);
    expect(safeEqualString("secret", "secreT")).toBe(false);
    expect(safeEqualString("secret", "secret-longer")).toBe(false);
    expect(safeEqualString("", "")).toBe(true);
  });
});
