import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ingestScriptDoc, parseAnyScriptDoc, parseScriptForRuntime, narrativeToText, toLegacyScriptDoc } from "./compat";
import { parseScriptDoc } from "./schema";
import { parseScriptDocV2, publicScriptViewV2 } from "./v2/schema";

const v2Path = path.join(process.cwd(), "seeds/examples/script-v2.example.json");
const v1Path = path.join(process.cwd(), "seeds/fixtures/script-v1.sample.json");

describe("V1/V2 剧本兼容层", () => {
  it("V2 可以投影为旧视图（仅测试对照）", () => {
    const v2 = parseScriptDocV2(JSON.parse(readFileSync(v2Path, "utf8")));
    const legacy = toLegacyScriptDoc(v2);
    expect(parseScriptDoc(legacy).meta.title).toBe(v2.meta.title);
    expect(legacy.locations).toContain("值班室");
    expect(legacy.characters.find((character) => character.id === "suyu")?.card.timeline).toContain("21:15–21:25");
    expect(parseScriptForRuntime(v2).truth.culpritId).toBe("suyu");
  });

  it("解析器按 version 选择 V1 或 V2；运行时一律得到 V2", () => {
    const v2 = JSON.parse(readFileSync(v2Path, "utf8"));
    expect(parseAnyScriptDoc(v2).version).toBe(2);
    const v1 = parseScriptDoc(JSON.parse(readFileSync(v1Path, "utf8")));
    expect(parseAnyScriptDoc(v1).version).toBe(1);
    expect(ingestScriptDoc(v1).doc.version).toBe(2);
    expect(parseScriptForRuntime(v1).version).toBe(2);
  });

  it("公开切片不包含私卡和真相", () => {
    const v2 = parseScriptDocV2(JSON.parse(readFileSync(v2Path, "utf8")));
    const publicView = publicScriptViewV2(v2) as Record<string, unknown>;
    expect(publicView).not.toHaveProperty("truth");
    expect(JSON.stringify(publicView)).not.toContain("privateCard");
  });

  it("内容块投影保留段落和列表的阅读顺序", () => {
    expect(narrativeToText([{ type: "paragraph", text: "第一段" }, { type: "list", style: "ordered", items: ["第二段", "第三段"] }])).toBe("第一段\n\n1. 第二段\n2. 第三段");
  });
});
