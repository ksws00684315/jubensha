import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { toJSONSchema } from "zod";
import { parseScriptDoc } from "../schema";
import { migrateV1ToV2 } from "./migrate-v1";
import { parseScriptDocV2, scriptDocV2Schema } from "./schema";
import { validateScriptV2 } from "./validate";
import { narrativeToText } from "../compat";

const examplePath = path.join(process.cwd(), "seeds/examples/script-v2.example.json");

describe("剧本输入标准 V2", () => {
  it("完整示例通过结构与逻辑校验", () => {
    const doc = parseScriptDocV2(JSON.parse(readFileSync(examplePath, "utf8")));
    expect(validateScriptV2(doc).filter((issue) => issue.level === "error")).toEqual([]);
  });

  it("文本叶不能用换行模拟排版", () => {
    const raw = JSON.parse(readFileSync(examplePath, "utf8")) as Record<string, unknown>;
    const broken = structuredClone(raw) as { meta: { title: string } };
    broken.meta.title = "包含\n换行";
    expect(scriptDocV2Schema.safeParse(broken).success).toBe(false);
  });

  it("跨对象引用必须指向真实 ID", () => {
    const doc = parseScriptDocV2(JSON.parse(readFileSync(examplePath, "utf8")));
    const broken = structuredClone(doc);
    broken.clues[0].locationId = "missing_location";
    expect(validateScriptV2(broken).some((issue) => issue.path === "clues.0.locationId" && issue.level === "error")).toBe(true);
  });

  it("提交的 JSON Schema 与权威 Zod Schema 一致", () => {
    const committed = JSON.parse(readFileSync(path.join(process.cwd(), "schemas/script-input-v2.schema.json"), "utf8"));
    expect(committed).toEqual(toJSONSchema(scriptDocV2Schema));
  });
});

describe("V1 → V2 迁移", () => {
  it("V1 固定件能转换且不产生结构错误", () => {
    const file = path.join(process.cwd(), "seeds/fixtures/script-v1.sample.json");
    const v1 = parseScriptDoc(JSON.parse(readFileSync(file, "utf8")));
    const { doc } = migrateV1ToV2(v1);
    expect(() => parseScriptDocV2(doc)).not.toThrow();
    expect(validateScriptV2(doc).filter((issue) => issue.level === "error")).toEqual([]);
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain(v1.characters[0].card.backstory.slice(0, 20));
    expect(serialized).toContain(v1.characters[0].card.secret.slice(0, 20));
  });
});

describe("现有种子都是可开局的 V2", () => {
  it("seeds 与 seeds/generated 全部 version=2 且无 error", () => {
    const roots = [path.join(process.cwd(), "seeds"), path.join(process.cwd(), "seeds/generated")];
    const files = roots.flatMap((root) => readdirSync(root).filter((file) => file.endsWith(".json")).map((file) => path.join(root, file)));
    expect(files.length).toBeGreaterThanOrEqual(33);

    for (const file of files) {
      const doc = parseScriptDocV2(JSON.parse(readFileSync(file, "utf8")));
      expect(doc.version, file).toBe(2);
      expect(validateScriptV2(doc).filter((issue) => issue.level === "error"), file).toEqual([]);
    }
  });

  it("天池雪会关键物证卡不直接点名真凶", () => {
    const doc = parseScriptDocV2(JSON.parse(readFileSync(path.join(process.cwd(), "seeds/generated/06p-tianchixuehui.json"), "utf8")));
    for (const id of ["laoshucang", "banshou", "lanangan", "xieyin", "jianduanxiu"]) {
      const clue = doc.clues.find((item) => item.id === id);
      expect(clue, id).toBeTruthy();
      expect(narrativeToText(clue!.content), id).not.toContain("方屿");
    }
    expect(doc.flow.searchRounds).toBe(3);
    expect(doc.flow.allowPrivateChat).toBe(false);
  });
});
