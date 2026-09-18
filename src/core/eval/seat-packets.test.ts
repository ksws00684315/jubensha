import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { auditSeatBlindReadPacket, buildSeatBlindReadPacket } from "./seat-packets";

const script = parseScriptDocV2(JSON.parse(readFileSync("seeds/sample-5p-cloudlanshan.json", "utf8")));

describe("独立座位盲读包", () => {
  it("只包含公共剧本和当前座位角色卡", () => {
    const packet = buildSeatBlindReadPacket(script, 0);
    expect(packet.publicScript).not.toHaveProperty("truth");
    expect(packet.seat.characterId).toBe(script.characters[0].id);
    expect(auditSeatBlindReadPacket(script, packet)).toEqual([]);
  });
});
