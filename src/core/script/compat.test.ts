import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAnyScriptDoc, parseScriptForRuntime, narrativeToText, toLegacyScriptDoc } from "./compat";
import { parseScriptDoc } from "./schema";
import { parseScriptDocV2, publicScriptViewV2 } from "./v2/schema";

const v2Path = path.join(process.cwd(), "seeds/examples/script-v2.example.json");

describe("V1/V2 剧本兼容层", () => {
  it("V2 可以投影为现有引擎可消费的 V1 视图", () => {
    const v2 = parseScriptDocV2(JSON.parse(readFileSync(v2Path, "utf8")));
    const legacy = toLegacyScriptDoc(v2);
    expect(parseScriptDoc(legacy).meta.title).toBe(v2.meta.title);
    expect(legacy.locations).toContain("值班室");
    expect(legacy.characters.find((character) => character.id === "suyu")?.card.timeline).toContain("21:15–21:25");
    expect(parseScriptForRuntime(v2).truth.culprit).toBe("suyu");
  });

  it("解析器按 version 选择 V1 或 V2，不改变 V1 输入", () => {
    const v2 = JSON.parse(readFileSync(v2Path, "utf8"));
    expect(parseAnyScriptDoc(v2).version).toBe(2);
    const v1 = parseScriptDoc(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf8")));
    expect(parseAnyScriptDoc(v1).version).toBe(1);
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
