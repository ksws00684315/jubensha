import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { auditScriptPlayability } from "./playability";
import { parseScriptDocV2 } from "./v2/schema";

function minimalDoc() {
  return parseScriptDocV2(JSON.parse(readFileSync("seeds/sample-5p-cloudlanshan.json", "utf8")));
}

describe("样板盲读可玩性审计", () => {
  it("通过最小可玩剧本", () => expect(auditScriptPlayability(minimalDoc()).filter((i) => i.level === "error")).toEqual([]));
  it("阻断所有角色都无法获得的材料", () => {
    const doc = minimalDoc();
    doc.clues[0].forbiddenCharacterIds = doc.characters.map((c) => c.id);
    expect(auditScriptPlayability(doc).some((i) => i.level === "error" && i.message.includes("不可达"))).toBe(true);
  });
});
