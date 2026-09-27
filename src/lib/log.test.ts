import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "./log";

let stdout = "";
let stderr = "";

function capture(stream: NodeJS.WriteStream, push: (chunk: string) => void): void {
  vi.spyOn(stream, "write").mockImplementation((chunk) => {
    push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
}

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.stubEnv("LOG_LEVEL", "info");
  vi.stubEnv("LOG_FORMAT", "json");
  vi.stubEnv("NODE_ENV", "test");
  capture(process.stdout, (chunk) => { stdout += chunk; });
  vi.spyOn(console, "error").mockImplementation((...args) => { stderr += args.map(String).join(" "); });
  vi.spyOn(console, "warn").mockImplementation((...args) => { stderr += args.map(String).join(" "); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("structured logger", () => {
  it("emits one JSON record with timestamp, level, message, and fields", () => {
    log.info("engine.ready", { gameId: "game-1", phase: "READING", round: 1 });
    const record = JSON.parse(stdout.trim());
    expect(record).toMatchObject({ level: "info", msg: "engine.ready", gameId: "game-1", phase: "READING", round: 1 });
    expect(record.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("redacts sensitive field names at every nesting level", () => {
    log.info("credentials", {
      token: "seat-token",
      nested: { apiKey: "provider-key", password: "admin-password", secret: "secret-value", cipherText: "cipher-value" },
      ticketId: "stream-ticket",
    });
    const record = JSON.parse(stdout.trim());
    expect(record.token).toBe("[redacted]");
    expect(record.ticketId).toBe("[redacted]");
    expect(record.nested).toEqual({ apiKey: "[redacted]", password: "[redacted]", secret: "[redacted]", cipherText: "[redacted]" });
  });

  it("redacts sk-prefixed values, bearer credentials, and key-value strings", () => {
    log.warn("provider rejected", { detail: "bad sk-abcdefghijklmnopqrstuvwxyz012345 and Bearer abcdefghijklmnop", note: "token=0123456789abcdef0123456789abcdef" });
    expect(stderr).not.toMatch(/sk-[A-Za-z0-9]{16}/);
    expect(stderr).not.toContain("abcdefghijklmnop");
    expect(stderr).not.toContain("0123456789abcdef0123456789abcdef");
    expect(stderr).toContain("[redacted]");
  });

  it("sanitizes Error messages without serializing stack traces or database passwords", () => {
    const error = new Error("connect failed postgresql://user:password123@localhost/db?token=long-secret");
    log.error("database.failure", { error });
    expect(stderr).toContain('"name":"Error"');
    expect(stderr).not.toContain("password123");
    expect(stderr).not.toContain("long-secret");
    expect(stderr).not.toContain(" at ");
  });

  it("filters below the configured minimum level", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    log.info("hidden");
    log.warn("visible.warning");
    log.error("visible.error");
    expect(stdout).not.toContain("hidden");
    expect(stderr).toContain("visible.warning");
    expect(stderr).toContain("visible.error");
  });

  it("uses human-readable single-line output only in development pretty mode", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOG_FORMAT", "pretty");
    log.info("pretty.event", { gameId: "g1" });
    expect(stdout).toMatch(/^\d{4}-\d\d-\d\dT.* INFO pretty\.event /);
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });

  it("does not allow fields to override the fixed envelope", () => {
    log.info("fixed.message", { level: "error", msg: "spoofed", requestId: "req-1" });
    expect(JSON.parse(stdout.trim())).toMatchObject({ level: "info", msg: "fixed.message", requestId: "req-1" });
  });
});
