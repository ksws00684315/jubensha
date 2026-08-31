import type { GameState } from "@/core/engine/types";
import type { ScriptDoc } from "@/core/script/schema";

export interface GuardResult {
  text: string;
  leaked: string[];
}

/**
 * ★ 输出守卫 ★
 * 检查 AI 玩家发言是否泄露了「未公开且不为其持有」的线索内容。
 * 注意：自己持有的线索可以转述（视为亲手翻到的）；只有别人未公开的线索才是泄密。
 * 命中时剥掉包含线索名的整句；仍不合格由调用方决定重试。
 */
export function guardPlayerSpeech(script: ScriptDoc, state: GameState, seatIndex: number, text: string): GuardResult {
  const leaked: string[] = [];
  let sanitized = text;

  for (const clue of script.clues) {
    const st = state.clueStates[clue.id];
    const isPublic = st?.isPublic ?? false;
    const heldByMe = (state.heldClues[seatIndex] ?? []).includes(clue.id);
    if (isPublic || heldByMe) continue;
    // 该线索未公开且不是我拿的：发言里不应出现线索名或其内容的独特片段
    const markers = [clue.name, ...uniqueNgrams(clue.content, 6)];
    for (const marker of markers) {
      if (marker && sanitized.includes(marker)) {
        leaked.push(clue.name);
        sanitized = stripSentencesContaining(sanitized, marker);
        break;
      }
    }
  }

  return { text: sanitized.trim(), leaked: [...new Set(leaked)] };
}

/**
 * DM 旁白守卫：REVEAL 之前不得出现真凶名、手法关键片段、未公开线索名。
 * 命中时剥掉整句；若剥完为空则退回安全旁白。
 */
export function guardDmSpeech(script: ScriptDoc, state: GameState, text: string): GuardResult {
  if (state.phase === "REVEAL" || state.phase === "ENDED") {
    return { text: text.trim(), leaked: [] };
  }
  const leaked: string[] = [];
  let sanitized = text;
  const culpritName = script.characters.find((c) => c.id === script.truth.culprit)?.name;
  const markers: Array<{ label: string; value: string }> = [];
  if (culpritName) markers.push({ label: culpritName, value: culpritName });
  for (const frag of uniqueNgrams(script.truth.method, 6)) {
    markers.push({ label: "手法", value: frag });
  }
  for (const clue of script.clues) {
    if (state.clueStates[clue.id]?.isPublic) continue;
    markers.push({ label: clue.name, value: clue.name });
    for (const frag of uniqueNgrams(clue.content, 6)) markers.push({ label: clue.name, value: frag });
  }
  for (const m of markers) {
    if (m.value && sanitized.includes(m.value)) {
      leaked.push(m.label);
      sanitized = stripSentencesContaining(sanitized, m.value);
    }
  }
  const textOut = sanitized.trim() || "（主持人整理了一下现场，请各位继续。）";
  return { text: textOut, leaked: [...new Set(leaked)] };
}

/** 剥掉包含关键词的句子（按 。！？；\n 分句） */
function stripSentencesContaining(text: string, marker: string): string {
  const parts = text.split(/(?<=[。！？；;\n])/);
  return parts.filter((p) => !p.includes(marker)).join("");
}

/** 抽取长度≥n 的独特片段（取标点分隔的短语，过滤太短的） */
function uniqueNgrams(content: string, minLen: number): string[] {
  return content
    .split(/[，。；：、（）()""\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= minLen)
    .slice(0, 5);
}
