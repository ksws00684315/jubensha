import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDbInstance } from "@/test/api";
import { db } from "@/lib/db";
import { invalidateBindingCache, resolveBinding } from "./client";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: vi.fn(() => "resolved-api-key") }));

const findBinding = vi.mocked(db.modelBinding.findUnique);

function bindingRow(overrides: { modelId?: string; enabled?: boolean } = {}) {
  return {
    id: "binding-player",
    slot: "player",
    providerId: "provider-1",
    modelId: overrides.modelId ?? "model-a",
    temperature: null,
    maxTokens: null,
    contextWindow: null,
    supportsSystem: true,
    supportsJson: false,
    fallbackSlot: null,
    detectedSystemSupport: null,
    provider: {
      id: "provider-1",
      name: "Test Provider",
      protocol: "openai_compatible",
      baseUrl: "https://example.test/v1",
      apiKeyCipher: "cipher",
      enabled: overrides.enabled ?? true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateBindingCache();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LLM binding cache", () => {
  it("TTL 内复用已解密绑定，到 60 秒时重新查询", async () => {
    findBinding.mockResolvedValue(bindingRow() as never);
    const first = await resolveBinding("player");
    expect(first.apiKey).toBe("resolved-api-key");

    vi.setSystemTime(Date.now() + 59_999);
    expect(await resolveBinding("player")).toBe(first);
    expect(findBinding).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    expect(await resolveBinding("player")).not.toBe(first);
    expect(findBinding).toHaveBeenCalledTimes(2);
  });

  it("invalidate 后重新读取绑定", async () => {
    findBinding.mockResolvedValueOnce(bindingRow({ modelId: "model-a" }) as never);
    findBinding.mockResolvedValueOnce(bindingRow({ modelId: "model-b" }) as never);
    expect((await resolveBinding("player")).modelId).toBe("model-a");
    invalidateBindingCache();
    expect((await resolveBinding("player")).modelId).toBe("model-b");
    expect(findBinding).toHaveBeenCalledTimes(2);
  });

  it("Provider 被禁用后，缓存失效即可按禁用状态生效", async () => {
    const row = bindingRow();
    findBinding.mockResolvedValue(row as never);
    await resolveBinding("player");
    row.provider.enabled = false;
    invalidateBindingCache();

    await expect(resolveBinding("player")).rejects.toThrow("已被禁用");
    expect(findBinding).toHaveBeenCalledTimes(2);
  });
});
