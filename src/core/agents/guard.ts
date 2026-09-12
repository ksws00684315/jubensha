import { clueText, methodText, narrativeToText } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import type { GameState } from "@/core/engine/types";

export interface GuardResult {
  text: string;
  leaked: string[];
}

export interface GuardMarker {
  /** 泄露源标签（线索名 / "手法" / 秘密标题），用于日志与去重 */
  label: string;
  /** 触发剥句的匹配串 */
  value: string;
}

const SENTENCE_SPLIT = /(?<=[。！？；;\n])/;

/**
 * ★ 输出守卫 ★
 * 检查 AI 玩家发言是否泄露了「未公开且不为其持有」的线索内容，以及
 * 自己「永不披露」（disclosure: never）的秘密原文（念卡式泄露；用自己的话
 * 部分承认不受影响，因为只匹配卡片原文片段）。
 * 注意：自己持有的线索可以转述（视为亲手翻到的）；只有别人未公开的线索才是泄密。
 */
export function playerGuardMarkers(script: ScriptDocV2, state: GameState, seatIndex: number): GuardMarker[] {
  const markers: GuardMarker[] = [];
  for (const clue of script.clues) {
    const st = state.clueStates[clue.id];
    const isPublic = st?.isPublic ?? false;
    const heldByMe = (state.heldClues[seatIndex] ?? []).includes(clue.id);
    if (isPublic || heldByMe) continue;
    markers.push({ label: clue.name, value: clue.name });
    for (const frag of uniqueNgrams(clueText(clue), 6)) markers.push({ label: clue.name, value: frag });
  }
  const character = script.characters.find((c) => c.id === state.seats[seatIndex]?.characterId);
  for (const secret of character?.privateCard.secrets ?? []) {
    if (secret.disclosure !== "never") continue;
    if (secret.title.length >= 4) markers.push({ label: secret.title, value: secret.title });
    for (const frag of uniqueNgrams(narrativeToText(secret.content), 6)) {
      markers.push({ label: secret.title, value: frag });
    }
  }
  return markers;
}

/** DM 旁白守卫标记：REVEAL 之前不得出现真凶名、手法关键片段、未公开线索名。 */
export function dmGuardMarkers(script: ScriptDocV2, state: GameState): GuardMarker[] {
  if (state.phase === "REVEAL" || state.phase === "ENDED") return [];
  const markers: GuardMarker[] = [];
  const culpritName = script.characters.find((c) => c.id === script.truth.culpritId)?.name;
  if (culpritName) markers.push({ label: culpritName, value: culpritName });
  for (const frag of uniqueNgrams(methodText(script), 6)) {
    markers.push({ label: "手法", value: frag });
  }
  for (const clue of script.clues) {
    if (state.clueStates[clue.id]?.isPublic) continue;
    markers.push({ label: clue.name, value: clue.name });
    for (const frag of uniqueNgrams(clueText(clue), 6)) markers.push({ label: clue.name, value: frag });
  }
  return markers;
}

function guardText(text: string, markers: GuardMarker[]): GuardResult {
  const leaked = new Set<string>();
  const kept = text
    .split(SENTENCE_SPLIT)
    .filter((sentence) => {
      const hit = markers.find((m) => m.value && sentence.includes(m.value));
      if (hit) {
        leaked.add(hit.label);
        return false;
      }
      return true;
    })
    .join("");
  return { text: kept.trim(), leaked: [...leaked] };
}

export function guardPlayerSpeech(script: ScriptDocV2, state: GameState, seatIndex: number, text: string): GuardResult {
  return guardText(text, playerGuardMarkers(script, state, seatIndex));
}

/** DM 旁白守卫：剥完为空时退回安全旁白。 */
export function guardDmSpeech(script: ScriptDocV2, state: GameState, text: string): GuardResult {
  const markers = dmGuardMarkers(script, state);
  const result = guardText(text, markers);
  const textOut = result.text || (markers.length ? "（主持人整理了一下现场，请各位继续。）" : "");
  return { text: textOut, leaked: result.leaked };
}

/**
 * ★ 流式增量守卫 ★
 * 真流式输出时无法先守卫全文再展示，改为句子级增量：只有跨过句子边界、
 * 且未命中任何泄露标记的句子才会被放出。最终 flush 的文本与逐句守卫全文等价，
 * 信息防火墙的「未守卫内容不出现在前端」保证不被流式破坏。
 */
export interface SpeechRedactor {
  /** 喂入新 chunk，返回 newly approved 的增量文本（可能为空串） */
  push(chunk: string): string;
  /** 流结束：返回剩余放行文本（delta）、全文与泄露清单 */
  flush(): { delta: string; text: string; leaked: string[] };
}

export function createSpeechRedactor(markers: GuardMarker[]): SpeechRedactor {
  let pending = "";
  let approved = "";
  const leaked = new Set<string>();
  const pass = (sentence: string): string => {
    const hit = markers.find((m) => m.value && sentence.includes(m.value));
    if (hit) {
      leaked.add(hit.label);
      return "";
    }
    return sentence;
  };
  return {
    push(chunk: string): string {
      pending += chunk;
      const parts = pending.split(SENTENCE_SPLIT);
      pending = parts.pop() ?? "";
      let emit = "";
      for (const sentence of parts) emit += pass(sentence);
      approved += emit;
      return emit;
    },
    flush() {
      const rest = pass(pending);
      pending = "";
      approved += rest;
      return { delta: rest, text: approved.trim(), leaked: [...leaked] };
    },
  };
}

function uniqueNgrams(content: string, minLen: number): string[] {
  return content
    .split(/[，。；：、（）()""\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= minLen)
    .slice(0, 5);
}
