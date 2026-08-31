import { describe, expect, it } from "vitest";
import { candidateModelListUrls, normalizeProviderBaseUrl } from "./provider-url";

describe("normalizeProviderBaseUrl", () => {
  it("Anthropic：去掉 /v1/messages，保留协议根", () => {
    expect(normalizeProviderBaseUrl("https://example.com/anthropic/v1/messages", "anthropic")).toBe(
      "https://example.com/anthropic"
    );
  });

  it("OpenAI 兼容：去掉 /chat/completions，保留 /v1", () => {
    expect(normalizeProviderBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
  });

  it("根地址保持不变", () => {
    expect(normalizeProviderBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });
});

describe("candidateModelListUrls", () => {
  it("从聊天路径向上探测到 /v1/models", () => {
    const urls = candidateModelListUrls("https://host.example/anthropic/v1/messages");
    expect(urls).toContain("https://host.example/v1/models");
    expect(urls).toContain("https://host.example/anthropic/v1/models");
    expect(urls.every((u) => u.startsWith("https://host.example"))).toBe(true);
  });
});
