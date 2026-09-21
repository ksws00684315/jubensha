import type { EngineEvent } from "./types";

export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
export function bigramSimilarity(a: string, b: string): number {
  const grams = (text: string) => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  const x = normalizeQuestion(a), y = normalizeQuestion(b);
  if (x === y) return x ? 1 : 0;
  const left = grams(x), right = grams(y);
  if (!left.size || !right.size) return 0;
  return 2 * [...left].filter((g) => right.has(g)).length / (left.size + right.size);
}
export function duplicateQuestion(events: EngineEvent[], round: number, toSeat: number, question: string, evidenceIds: readonly string[]): boolean {
  const key = [...new Set(evidenceIds)].sort().join(",");
  return events.some((event) => {
    if (event.phase !== "DISCUSSION" || event.round !== round || event.toSeat !== toSeat || !event.content.questionId || event.content.answer) return false;
    const priorIds = Array.isArray(event.content.evidenceIds) ? event.content.evidenceIds as string[] : [];
    if (key && [...priorIds].sort().join(",") === key) return true;
    const newEvidence = evidenceIds.some((id) => events.some((clue) => clue.type === "clue" && clue.visibility === "public" && clue.content.clueId === id && BigInt(clue.seq) > BigInt(event.seq)));
    if (newEvidence) return false;
    return bigramSimilarity(question, String(event.content.question ?? event.content.text ?? "")) >= 0.72;
  });
}
