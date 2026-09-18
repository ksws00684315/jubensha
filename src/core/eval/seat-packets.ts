import { createHash } from "node:crypto";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import { narrativeToText } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { buildFixedEvaluationBundle } from "./snapshots";

export interface SeatBlindReadPacket {
  version: 1;
  scriptHash: string;
  scriptTitle: string;
  seatIndex: number;
  publicScript: ReturnType<typeof publicScriptViewV2>;
  seat: {
    characterId: string;
    characterName: string;
    privateCard: ScriptDocV2["characters"][number]["privateCard"];
  };
  snapshots: ReturnType<typeof buildFixedEvaluationBundle>["bundle"]["snapshots"];
}

function hashScript(script: ScriptDocV2): string {
  return createHash("sha256").update(JSON.stringify(script)).digest("hex");
}

/** 构造一个座位的盲读包：公共剧本 + 本人角色卡 + 合法评估快照。 */
export function buildSeatBlindReadPacket(script: ScriptDocV2, seatIndex: number): SeatBlindReadPacket {
  const character = script.characters[seatIndex];
  if (!character) throw new Error(`座位 ${seatIndex} 不存在`);
  const fixed = buildFixedEvaluationBundle(script, seatIndex);
  return {
    version: 1,
    scriptHash: hashScript(script),
    scriptTitle: script.meta.title,
    seatIndex,
    publicScript: publicScriptViewV2(script),
    seat: { characterId: character.id, characterName: character.name, privateCard: character.privateCard },
    snapshots: fixed.bundle.snapshots,
  };
}

/** 盲读包结构越权检查：不允许出现 truth 或其他角色私卡正文。 */
export function auditSeatBlindReadPacket(script: ScriptDocV2, packet: SeatBlindReadPacket): string[] {
  const issues: string[] = [];
  const serialized = JSON.stringify(packet);
  if ("truth" in packet.publicScript || serialized.includes('"truth":')) issues.push("盲读包包含 truth 字段");
  for (const character of script.characters) {
    if (character.id === packet.seat.characterId) continue;
    for (const secret of character.privateCard.secrets) {
      const text = narrativeToText(secret.content);
      if (text.length >= 12 && serialized.includes(text)) issues.push(`盲读包泄露其他角色秘密：${character.id}/${secret.id}`);
    }
  }
  return issues;
}
