import { describe, expect, it } from "vitest";
import { BINDING_SLOTS, BINDING_SLOT_KEYS, PROVIDER_PRESETS } from "./provider-presets";

describe("BINDING_SLOTS", () => {
  it("覆盖运行时全部用途槽位（含 embedding）", () => {
    // embedding 曾经只在运行时类型里存在，导致向量检索记忆层在生产中不可达
    expect(BINDING_SLOT_KEYS).toContain("embedding");
    for (const key of ["dm", "culprit", "player", "generator", "tts", "embedding"] as const) {
      expect(BINDING_SLOT_KEYS).toContain(key);
    }
  });

  it("key 唯一，且每项都有标签与说明", () => {
    const keys = BINDING_SLOTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const slot of BINDING_SLOTS) {
      expect(slot.label.trim()).not.toBe("");
      expect(slot.description.trim()).not.toBe("");
    }
  });
});

describe("PROVIDER_PRESETS", () => {
  it("key 唯一，baseUrl 为绝对地址", () => {
    const keys = PROVIDER_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PROVIDER_PRESETS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.commonModels.length).toBeGreaterThan(0);
    }
  });
});
