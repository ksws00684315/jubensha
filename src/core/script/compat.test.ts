import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { clearScriptRuntimeCache, ingestScriptDoc, locationNames, parseAnyScriptDoc, parseScriptForRuntime, narrativeToText, resolveFinaleOutcome, resolveLocation, toLegacyScriptDoc } from "./compat";
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

  it("搜证地点可用名称或 id 解析", () => {
    const v2 = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/sample-5p-cloudlanshan.json"), "utf8")));
    const byName = resolveLocation(v2, "书房");
    const byId = resolveLocation(v2, "location_1");
    expect(byName?.id).toBe("location_1");
    expect(byId?.name).toBe("书房");
    expect(locationNames(v2)).toContain("书房");
  });

  it("运行时解析缓存：同内容命中同一对象，内容变化即失效", () => {
    clearScriptRuntimeCache();
    const raw = JSON.parse(readFileSync(v2Path, "utf8"));
    const first = parseScriptForRuntime(raw);
    const second = parseScriptForRuntime(JSON.parse(JSON.stringify(raw)));
    expect(second).toBe(first); // 命中缓存（引用相等）

    const changed = JSON.parse(JSON.stringify(raw));
    changed.meta.durationMin = (changed.meta.durationMin ?? 120) + 1;
    const third = parseScriptForRuntime(changed);
    expect(third).not.toBe(first); // 键不同不误命中

    const mutated = JSON.parse(JSON.stringify(raw));
    mutated.meta.title = "改名后的剧本";
    const fourth = parseScriptForRuntime(mutated);
    expect(fourth.meta.title).toBe("改名后的剧本");
    expect(fourth).not.toBe(first);
    clearScriptRuntimeCache();
  });

  it("终局只投影命中的一个 outcome", () => {
    const v2 = parseScriptDocV2(JSON.parse(readFileSync(v2Path, "utf8")));
    const caught = resolveFinaleOutcome(v2, { culpritSeat: 1, caught: true });
    const escaped = resolveFinaleOutcome(v2, { culpritSeat: 1, caught: false });
    expect(caught.result).toBe("caught");
    expect(caught.title).toBe("真凶被捕");
    expect(caught.content).not.toContain("未能指认");
    expect(escaped.result).toBe("escaped");
    expect(escaped.title).toBe("真凶逃脱");
  });
});
