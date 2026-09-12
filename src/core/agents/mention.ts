import type { GameState } from "@/core/engine/types";
import { activeSeats } from "@/core/engine/state";
import type { ScriptDocV2 } from "@/core/script/v2/schema";

/**
 * ★ 插话调度 ★（SillyTavern 群聊 natural order 的 mention 激活思路，去随机化）
 * 最后一条消息里被整词提到名字的 AI 成员获得发言权；规则引擎只做激活，
 * 回应内容由被点名的 AI 自己生成，不占用其正式发言回合。
 */

/** 每轮讨论允许的插话总数上限 */
export const MAX_INTERJECTIONS_PER_ROUND = 3;

/**
 * 从一段发言里找出被点名（提到角色名）的 AI 座位，按名字在文中出现的位置排序。
 * 只认角色名精确出现；真人/空座/自己不参与激活。
 */
export function mentionedAiSeats(script: ScriptDocV2, state: GameState, text: string, excludeSeat?: number): number[] {
  if (!text.trim()) return [];
  const hits: Array<{ seat: number; at: number }> = [];
  for (const seat of activeSeats(state)) {
    if (seat === excludeSeat) continue;
    if (state.seats[seat].kind !== "ai") continue;
    const character = script.characters.find((c) => c.id === state.seats[seat].characterId);
    if (!character?.name) continue;
    const at = text.indexOf(character.name);
    if (at >= 0) hits.push({ seat, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.seat);
}
