import { clueText } from "@/core/script/compat";
import type { EngineEvent, GameState } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

export type EvidenceKind = "clue" | "claim";

/** 从已发生事实派生的公开证据；它不是游戏状态的第二个真相来源。 */
export interface PublicEvidenceRecord {
  id: string;
  kind: EvidenceKind;
  title: string;
  text: string;
  clueId?: string;
  sourceSeqs: string[];
  sourceSeats: number[];
  /** claim 保留说话人；不能被摘要器改写成事实。 */
  speakerSeat?: number;
}

function seqNumber(seq: string): bigint {
  try {
    return BigInt(seq);
  } catch {
    return BigInt(0);
  }
}

/**
 * 公开证据登记：
 * - 公开线索始终从 clueStates 派生，转交或摘要不会抹除原文；
 * - 玩家发言只登记为 claim，并保留说话人和事件序号；
 * - 不读取 truth、其他角色私卡或未公开线索。
 */
export function buildPublicEvidenceRegistry(script: ScriptDocV2, state: Pick<GameState, "clueStates">, events: EngineEvent[]): PublicEvidenceRecord[] {
  const records: PublicEvidenceRecord[] = [];
  for (const clue of script.clues) {
    if (!state.clueStates[clue.id]?.isPublic) continue;
    const sourceEvents = events.filter((event) => event.type === "clue" && event.visibility === "public" && event.content.clueId === clue.id);
    records.push({
      id: `clue:${clue.id}`,
      kind: "clue",
      title: clue.name,
      text: clueText(clue),
      clueId: clue.id,
      sourceSeqs: sourceEvents.map((event) => event.seq),
      sourceSeats: [...new Set(sourceEvents.map((event) => event.fromSeat).filter((seat): seat is number => seat !== null))],
    });
  }
  for (const event of events) {
    if (event.type !== "speech" || event.visibility !== "public" || typeof event.content.text !== "string" || !event.content.text.trim()) continue;
    records.push({
      id: `claim:${event.seq}`,
      kind: "claim",
      title: typeof event.content.speakerName === "string" ? event.content.speakerName : event.fromSeat === null ? "主持人" : `玩家${event.fromSeat + 1}`,
      text: event.content.text,
      sourceSeqs: [event.seq],
      sourceSeats: event.fromSeat === null ? [] : [event.fromSeat],
      speakerSeat: event.fromSeat ?? undefined,
    });
  }
  return records.sort((a, b) => seqNumber(a.sourceSeqs[0] ?? "0") < seqNumber(b.sourceSeqs[0] ?? "0") ? -1 : 1);
}

export function renderPublicEvidenceRegistry(records: PublicEvidenceRecord[], opts: { includeClaims?: boolean } = {}): string {
  return records
    .filter((record) => opts.includeClaims || record.kind === "clue")
    .map((record) => {
      const source = record.sourceSeqs.length ? `来源事件：${record.sourceSeqs.map((seq) => `#${seq}`).join("、")}` : "来源事件：状态登记";
      const kind = record.kind === "clue" ? "公开线索" : "玩家陈述（仅作待核实主张）";
      return `· 【${kind}】${record.title}（${source}）：${record.text}`;
    })
    .join("\n");
}
