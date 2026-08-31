import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseScriptDoc, scriptDocSchema } from "./schema";
import { validateScript } from "./validate";
import { parseScriptDocV2 } from "./v2/schema";
import { isScriptPlayable, validateScriptV2 } from "./v2/validate";

const samplePath = path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json");
const v1FixturePath = path.join(process.cwd(), "seeds/fixtures/script-v1.sample.json");

describe("样例剧本 V2", () => {
  const raw = JSON.parse(readFileSync(samplePath, "utf-8"));
  const doc = parseScriptDocV2(raw);

  it("通过结构校验", () => {
    expect(doc.version).toBe(2);
    expect(doc.meta.title).toBeTruthy();
  });

  it("通过逻辑校验（无 error）", () => {
    expect(validateScriptV2(doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("真凶是苏晚且标记一致", () => {
    const culprit = doc.characters.find((c) => c.id === doc.truth.culpritId);
    expect(culprit?.name).toBe("苏晚");
    expect(culprit?.privateCard.isCulprit).toBe(true);
    expect(doc.characters.filter((c) => c.privateCard.isCulprit)).toHaveLength(1);
  });

  it("可开局", () => {
    expect(isScriptPlayable(doc).ok).toBe(true);
  });
});

describe("V1 固定件仍可被解析", () => {
  const raw = JSON.parse(readFileSync(v1FixturePath, "utf-8"));
  const doc = parseScriptDoc(raw);

  it("通过 V1 结构校验", () => {
    expect(scriptDocSchema.safeParse(raw).success).toBe(true);
    expect(validateScript(doc).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("V2 逻辑校验器", () => {
  const base = parseScriptDocV2(JSON.parse(readFileSync(samplePath, "utf-8")));

  it("真凶不存在于角色列表时报错", () => {
    const broken = structuredClone(base);
    broken.truth.culpritId = "nonexistent";
    const { ok, errors } = isScriptPlayable(broken);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("角色不存在"))).toBe(true);
  });

  it("isCulprit 与 truth 不一致时报错", () => {
    const broken = structuredClone(base);
    const c = broken.characters.find((x) => x.id === broken.truth.culpritId)!;
    c.privateCard.isCulprit = false;
    const { ok } = isScriptPlayable(broken);
    expect(ok).toBe(false);
  });

  it("线索地点非法时报错", () => {
    const broken = structuredClone(base);
    broken.clues[0].locationId = "missing_location";
    const { ok, errors } = isScriptPlayable(broken);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes("地点不存在"))).toBe(true);
  });
});
