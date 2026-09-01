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
  | { type: "taken" }
  | { type: "full" }
  | { type: "claim"; open: JoinableSeat[] };

/** 凭旧 token（或房主 token 明确确认）恢复座位；昵称本身不是凭证。 */
export function decideJoin(
  roomStatus: string,
  seats: JoinableSeat[],
  name: string,
  presentedToken?: string | null,
  presentedHostToken?: string | null,
  roomHostToken?: string | null,
): JoinDecision {
  const trimmed = name.trim();
  const named = seats.filter((s) => s.kind === "human" && (s.playerName ?? "").trim() === trimmed);
  if (named.length > 1) return { type: "ambiguous" };
  if (named.length === 1) {
    const hostConfirmed = Boolean(presentedHostToken && roomHostToken && presentedHostToken === roomHostToken);
    if (named[0].token && (named[0].token === presentedToken || hostConfirmed)) return { type: "resume", seat: named[0] };
    return roomStatus === "lobby" ? { type: "taken" } : { type: "started" };
  }
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
  name: string,
  presentedToken?: string | null,
  presentedHostToken?: string | null,
  roomHostToken?: string | null,
): DmJoinDecision {
  if (!humanDm) return "not-human-dm";
  if (dmToken && (dmName ?? "").trim() === name.trim()) {
    const hostConfirmed = Boolean(presentedHostToken && roomHostToken && presentedHostToken === roomHostToken);
    return dmToken === presentedToken || hostConfirmed ? "resume" : "taken";
  }
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
