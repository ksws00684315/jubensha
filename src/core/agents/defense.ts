import type { DefenseHookV2 } from "@/core/script/v2/schema";
import type { GameState } from "@/core/engine/types";

export function defenseBroken(hook: DefenseHookV2, state: Pick<GameState, "clueStates">): boolean {
  const publicClue = (id: string) => state.clueStates[id]?.isPublic === true;
  if (hook.brokenWhen) {
    const { allPublicClueIds: all, anyPublicClueIds: any } = hook.brokenWhen;
    return Boolean((all?.length && all.every(publicClue)) || any?.some(publicClue));
  }
  return (hook.brokenByPublicClueIds ?? []).some(publicClue);
}
