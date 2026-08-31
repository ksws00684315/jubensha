import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDoc, scriptDocSchema } from "./schema";
import { isScriptPlayable, validateScript } from "./validate";

const samplePath = path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json");

describe("样例剧本", () => {
  const raw = JSON.parse(readFileSync(samplePath, "utf-8"));
  const doc = parseScriptDoc(raw);

  it("通过结构校验", () => {
    const parsed = scriptDocSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("通过逻辑校验（无 error）", () => {
    const errors = validateScript(doc).filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("真凶是苏晚且标记一致", () => {
    const culprit = doc.characters.find((c) => c.id === doc.truth.culprit);
    expect(culprit?.name).toBe("苏晚");
    expect(culprit?.card.isCulprit).toBe(true);
    expect(doc.characters.filter((c) => c.card.isCulprit)).toHaveLength(1);
  });

  it("可开局", () => {
    expect(isScriptPlayable(doc).ok).toBe(true);
  });
});

describe("逻辑校验器", () => {
  const base = parseScriptDoc(JSON.parse(readFileSync(samplePath, "utf-8")));

  it("真凶不存在于角色列表时报错", () => {
    const broken = structuredClone(base);
    broken.truth.culprit = "nonexistent";
    const { ok, errors } = isScriptPlayable(broken);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("不存在于角色列表"))).toBe(true);
  });

  it("isCulprit 与 truth 不一致时报错", () => {
    const broken = structuredClone(base);
    const c = broken.characters.find((x) => x.id === broken.truth.culprit)!;
    c.card.isCulprit = false;
    const { ok } = isScriptPlayable(broken);
    expect(ok).toBe(false);
  });

  it("线索地点非法时报错", () => {
    const broken = structuredClone(base);
    broken.clues[0].location = "不存在的地点";
    const { ok, errors } = isScriptPlayable(broken);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("不在 locations 中"))).toBe(true);
  });

  it("角色缺少秘密时报错", () => {
    const broken = structuredClone(base);
    broken.characters[0].card.secret = "";
    const { ok, errors } = isScriptPlayable(broken);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("秘密"))).toBe(true);
  });
});
