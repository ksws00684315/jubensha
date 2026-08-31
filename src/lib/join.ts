export type JoinableSeat = {
  id: string;
  index: number;
  kind: string;
  playerName: string | null;
  token: string | null;
  characterId: string | null;
};

export type JoinDecision =
  | { type: "ambiguous" }
  | { type: "resume"; seat: JoinableSeat }
  | { type: "started" }
  | { type: "full" }
  | { type: "claim"; open: JoinableSeat[] };

/** 凭昵称入座或认领已有座位。同名多个真人座视为歧义。 */
export function decideJoin(roomStatus: string, seats: JoinableSeat[], name: string): JoinDecision {
  const trimmed = name.trim();
  const named = seats.filter((s) => s.kind === "human" && (s.playerName ?? "").trim() === trimmed);
  if (named.length > 1) return { type: "ambiguous" };
  if (named.length === 1) return { type: "resume", seat: named[0] };
  if (roomStatus !== "lobby") return { type: "started" };
  const open = seats.filter((s) => s.kind === "human" && !s.token);
  if (!open.length) return { type: "full" };
  return { type: "claim", open };
}

export type DmJoinDecision = "not-human-dm" | "resume" | "claim" | "taken";

export function decideDmJoin(
  humanDm: boolean,
  dmToken: string | null,
  dmName: string | null,
  name: string
): DmJoinDecision {
  if (!humanDm) return "not-human-dm";
  if (dmToken && (dmName ?? "").trim() === name.trim()) return "resume";
  if (dmToken) return "taken";
  return "claim";
}

export function gameEventsUrl(
  gameId: string,
  opts: { seat?: number | null; token?: string | null; dm?: boolean; dmToken?: string | null; lastSeq?: string }
): string {
  const q = new URLSearchParams();
  if (opts.dm) {
    q.set("dm", "1");
    if (opts.dmToken) q.set("dmtoken", opts.dmToken);
  } else if (opts.seat != null && opts.token) {
    q.set("seat", String(opts.seat));
    q.set("token", opts.token);
  }
  if (opts.lastSeq && opts.lastSeq !== "0") q.set("lastSeq", opts.lastSeq);
  const s = q.toString();
  return `/api/games/${gameId}/events${s ? `?${s}` : ""}`;
}
