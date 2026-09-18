import { afterEach, describe, expect, it } from "vitest";
import { assertProviderUrlAllowed, isPrivateIp } from "./url-guard";

const ORIGINAL = process.env.ALLOW_PRIVATE_PROVIDER_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOW_PRIVATE_PROVIDER_URL;
  else process.env.ALLOW_PRIVATE_PROVIDER_URL = ORIGINAL;
});

describe("isPrivateIp", () => {
  it("识别常见私网/回环/元数据段", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("192.168.0.9")).toBe(true);
    expect(isPrivateIp("172.16.5.5")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
});

describe("assertProviderUrlAllowed", () => {
  it("云元数据/链路本地无条件封禁", async () => {
    await expect(assertProviderUrlAllowed("http://169.254.169.254/latest/meta-data")).rejects.toThrow("SSRF");
    await expect(assertProviderUrlAllowed("http://[fe80::1]/v1")).rejects.toThrow("SSRF");
    await expect(assertProviderUrlAllowed("http://metadata.google.internal/")).rejects.toThrow("SSRF");
  });

  it("默认放行本地推理（Ollama 等）", async () => {
    await expect(assertProviderUrlAllowed("http://localhost:11434/v1")).resolves.toBeUndefined();
    await expect(assertProviderUrlAllowed("http://127.0.0.1:11434/v1")).resolves.toBeUndefined();
  });

  it("ALLOW_PRIVATE_PROVIDER_URL=0 收紧回环/私网", async () => {
    process.env.ALLOW_PRIVATE_PROVIDER_URL = "0";
    await expect(assertProviderUrlAllowed("http://127.0.0.1:11434/v1")).rejects.toThrow("ALLOW_PRIVATE_PROVIDER_URL");
    await expect(assertProviderUrlAllowed("http://10.0.0.5:8000/v1")).rejects.toThrow("ALLOW_PRIVATE_PROVIDER_URL");
    await expect(assertProviderUrlAllowed("http://localhost:11434/v1")).rejects.toThrow("ALLOW_PRIVATE_PROVIDER_URL");
  });

  it("拒绝非法协议与空值", async () => {
    await expect(assertProviderUrlAllowed("ftp://example.com")).rejects.toThrow();
    await expect(assertProviderUrlAllowed("")).rejects.toThrow();
  });

  it("DNS 解析失败不在守卫处拦截（交给 fetch 报连接错误）", async () => {
    await expect(assertProviderUrlAllowed("http://nonexistent-host-for-tests.invalid/v1")).resolves.toBeUndefined();
  });
});
