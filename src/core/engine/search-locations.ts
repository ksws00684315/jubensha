import type { ClueV2, LocationV2 } from "@/core/script/v2/schema";
import { clueReachable } from "./state";
import type { ClueRuntime } from "./types";

export type SearchLocationOption = {
  name: string;
  status: "available" | "own_room" | "exhausted" | "locked";
  reason?: string;
};

export function searchLocationOptions(args: {
  locations: LocationV2[];
  clues: ClueV2[];
  clueStates: Record<string, ClueRuntime | undefined>;
  seatCharacterId: string | null;
  round: number;
}): SearchLocationOption[] {
  const publicClueIds = new Set(Object.entries(args.clueStates).filter(([, state]) => state?.isPublic).map(([id]) => id));
  return args.locations.map((location) => {
    if (args.seatCharacterId && location.ownerCharacterId === args.seatCharacterId) {
      return { name: location.name, status: "own_room", reason: "这是你的房间" };
    }
    const unsearched = args.clues.filter((clue) => clue.locationId === location.id && args.clueStates[clue.id] === undefined);
    if (!unsearched.length) return { name: location.name, status: "exhausted", reason: "线索已搜完" };
    if (unsearched.some((clue) => clueReachable(clue, { seatCharacterId: args.seatCharacterId, round: args.round, publicClueIds }))) {
      return { name: location.name, status: "available" };
    }
    return { name: location.name, status: "locked", reason: "尚未满足线索开放条件" };
  });
}
