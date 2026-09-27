import { z } from "zod";

/** Narrow persisted seat columns into the engine's trusted seat shape. */
export const seatInfoSchema = z.object({
  index: z.number().int().nonnegative(),
  kind: z.enum(["human", "ai", "empty"]),
  characterId: z.string(),
  playerName: z.string(),
}).strict();
