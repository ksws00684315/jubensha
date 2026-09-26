import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appConfigPath, readAppConfig, resolveDatabaseUrl, writeAppConfig, assertPostgresUrl, maskDatabaseUrl } from "./app-config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("APP_CONFIG_PATH 覆盖", () => {
  it("设置后读写都落在指定文件", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "app-config-"));
    const file = path.join(dir, "custom.json");
    vi.stubEnv("APP_CONFIG_PATH", file);
    try {
      expect(appConfigPath()).toBe(file);
      writeAppConfig({ databaseUrl: "postgresql://u:p@127.0.0.1:5433/custom" });
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")).databaseUrl).toContain("custom");
      expect(readAppConfig().databaseUrl).toContain("custom");
      expect(resolveDatabaseUrl().source).toBe("file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("指向不存在的文件时回落到 DATABASE_URL", () => {
    const file = path.join(os.tmpdir(), "app-config-missing-does-not-exist.json");
    vi.stubEnv("APP_CONFIG_PATH", file);
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:5433/envdb");
    // 越过 1s 配置缓存 TTL，强制重新读盘（前面用例可能刚写过别的文件）
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    expect(resolveDatabaseUrl()).toEqual({ url: "postgresql://u:p@127.0.0.1:5433/envdb", source: "env" });
  });
});

describe("assertPostgresUrl", () => {
  it("接受 postgresql 与 postgres 协议", () => {
    expect(assertPostgresUrl("postgresql://u:p@db.example.com:5432/jbs")).toContain("db.example.com");
    expect(assertPostgresUrl("postgres://u:p@127.0.0.1:5432/jbs")).toContain("127.0.0.1");
  });

  it("拒绝非 postgres 协议", () => {
    expect(() => assertPostgresUrl("mysql://localhost/jbs")).toThrow(/postgresql/);
  });
});

describe("maskDatabaseUrl", () => {
  it("隐藏密码", () => {
    const masked = maskDatabaseUrl("postgresql://alice:s3cret@db.example.com:5432/jubensha?sslmode=require");
    expect(masked).toContain("alice");
    expect(masked).toContain("db.example.com");
    expect(masked).toContain("****");
    expect(masked).not.toContain("s3cret");
  });
});
