import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { auditScriptPlayability } from "./playability";
import { parseScriptDocV2 } from "./v2/schema";

function minimalDoc() {
  return parseScriptDocV2(JSON.parse(readFileSync("seeds/sample-5p-cloudlanshan.json", "utf8")));
}

function withClueText(id: string, text: string) {
  const doc = minimalDoc();
  doc.clues.find((clue) => clue.id === id)!.content = [{ type: "paragraph", text }];
  return doc;
}

function withKnowledge(characterIndex: number, text: string) {
  const doc = minimalDoc();
  doc.characters[characterIndex].privateCard.knowledge[0].content = [{ type: "paragraph", text }];
  return doc;
}

describe("样板盲读可玩性审计", () => {
  it("通过最小可玩剧本", () => expect(auditScriptPlayability(minimalDoc()).filter((i) => i.level === "error")).toEqual([]));
  it("阻断所有角色都无法获得的材料", () => {
    const doc = minimalDoc();
    doc.clues[0].forbiddenCharacterIds = doc.characters.map((c) => c.id);
    expect(auditScriptPlayability(doc).some((i) => i.level === "error" && i.message.includes("不可达"))).toBe(true);
  });
  it("样板种子没有卡内判词，也没有抹名目击", () => {
    expect(auditScriptPlayability(minimalDoc()).filter((i) => i.message.includes("判词") || i.message.includes("空话"))).toEqual([]);
  });
  it("判词卡报 warning 不报 error", () => {
    const issues = auditScriptPlayability(withClueText("footprint", "这枚脚印足以说明苏晚到过书房。"));
    expect(issues.some((i) => i.level === "warning" && i.message.includes("判词"))).toBe(true);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("抹名目击报 warning，点名目击不报", () => {
    expect(auditScriptPlayability(withKnowledge(1, "21:20 你亲眼看见有人从书房出来，没看清脸。")).some((i) => i.level === "warning" && i.message.includes("空话"))).toBe(true);
    expect(auditScriptPlayability(withKnowledge(1, "21:20 你亲眼看见苏晚从书房出来，手里拎着自己的出诊包。")).some((i) => i.message.includes("空话"))).toBe(false);
  });
});
