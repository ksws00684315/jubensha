import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseScriptDocV2 } from "@/core/script/v2/schema";
import { auditSeatBlindReadPacket, buildSeatBlindReadPacket } from "@/core/eval/seat-packets";

const targets = [
  ["seeds/sample-5p-cloudlanshan.json", "cloudlanshan"],
  ["seeds/generated/5p-diqifengheka.json", "diqifengheka"],
] as const;
const outputDir = resolve(process.env.JUBENSHA_BLIND_READ_OUT ?? ".workbuddy/eval/seat-packets");
mkdirSync(outputDir, { recursive: true });
let failures = 0;
for (const [file, slug] of targets) {
  const script = parseScriptDocV2(JSON.parse(readFileSync(resolve(file), "utf8")));
  const index: Array<{ seatIndex: number; characterId: string; characterName: string; packet: string }> = [];
  for (let seatIndex = 0; seatIndex < script.characters.length; seatIndex++) {
    const packet = buildSeatBlindReadPacket(script, seatIndex);
    const issues = auditSeatBlindReadPacket(script, packet);
    if (issues.length) {
      failures += issues.length;
      console.error(`✗ ${script.meta.title} 座位${seatIndex + 1}: ${issues.join("；")}`);
      continue;
    }
    const packetFile = `${slug}-seat-${seatIndex + 1}.json`;
    writeFileSync(resolve(outputDir, packetFile), JSON.stringify(packet, null, 2) + "\n");
    index.push({ seatIndex, characterId: packet.seat.characterId, characterName: packet.seat.characterName, packet: packetFile });
  }
  writeFileSync(resolve(outputDir, `${slug}-index.json`), JSON.stringify({ version: 1, scriptTitle: script.meta.title, scriptHash: buildSeatBlindReadPacket(script, 0).scriptHash, packets: index }, null, 2) + "\n");
  console.log(`${failures ? "△" : "✓"} ${script.meta.title} seats=${index.length}`);
}
process.exitCode = failures ? 1 : 0;
