import { describe, expect, it } from "vitest";
import { assertPostgresUrl, maskDatabaseUrl } from "./app-config";

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
