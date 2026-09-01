"use client";

/** 客户端 fetch 帮助函数 */

import type { CharacterV2, ClueV2, PrivateCardV2, PublicScriptViewV2, TruthV2 } from "@/core/script/v2/schema";

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败（${res.status}）`);
  return data as T;
}

export interface ScriptSummary {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  durationMin: number;
  difficulty: string;
  tags: string[];
  intro: string;
  source: string;
  updatedAt: string;
}

export interface SeatView {
  index: number;
  kind: "human" | "ai" | "empty";
  playerName: string | null;
  hasToken?: boolean;
  character: { id: string; name: string; publicBio: string } | null;
}

export interface RoomView {
  id: string;
  code: string;
  status: string;
  gameId: string | null;
  gamePhase: string | null;
  humanDm?: boolean;
  dmTaken?: boolean;
  dmName?: string | null;
  script: { id: string; title: string; intro: string; difficulty: string; durationMin: number };
  seats: SeatView[];
  characters: Array<{ id: string; name: string; publicBio: string }>;
}

export interface GameEventView {
  seq: string;
  type: "phase" | "speech" | "system" | "clue" | "vote" | "private" | "reveal" | "thinking";
  phase: string;
  round: number;
  fromSeat: number | null;
  toSeat: number | null;
  visibility: string;
  content: {
    text?: string;
    speakerName?: string;
    clueId?: string;
    clueName?: string;
    clueContent?: string;
    location?: string;
    target?: number;
    reason?: string;
    culpritName?: string;
    caught?: boolean;
    counts?: Record<string, number>;
    reveal?: string;
    method?: string;
    fullTimeline?: string;
    winText?: string;
    phase?: string;
    [k: string]: unknown;
  };
  createdAt: string;
}

export interface GameSummary {
  id: string;
  roomId: string;
  roomCode: string;
  status: string;
  phase: string;
  round: number;
  scriptTitle: string;
  background: string;
  flow: { searchRounds: number; discussionRounds: number; allowPrivateChat: boolean; privateChatMessageLimit: number };
  locations: string[];
  availableLocations: string[];
  seats: Array<{
    index: number;
    kind: "human" | "ai" | "empty";
    playerName: string | null;
    characterName: string | null;
    characterPublicBio: string | null;
    myCard: {
      backstory: string;
      secret: string;
      goal: string;
      isCulprit: boolean;
      timeline: string;
      knowledge: string[];
      persona: string;
    } | null;
    myCardV2: PrivateCardV2 | null;
  }>;
  mySeat: number | null;
  myClues: string[];
  clues: Array<{ id: string; name: string; location: string }>;
  scriptV2: Pick<PublicScriptViewV2, "background" | "characters" | "locations"> | null;
  myCluesV2: ClueV2[];
}

export interface DmStructuredView {
  truth: TruthV2;
  characters: Array<{ id: string; name: string; publicProfile: CharacterV2["publicProfile"]; privateCard: PrivateCardV2; seatIndex: number | null }>;
  clues: ClueV2[];
}

export const PHASE_LABEL: Record<string, string> = {
  LOBBY: "等待开局",
  READING: "读本",
  SELF_INTRO: "自我介绍",
  SEARCH: "搜证",
  DISCUSSION: "圆桌讨论",
  VOTE: "投票",
  REVEAL: "真相揭晓",
  ENDED: "已结束",
};

/** 本地玩家身份存取（seatIndex 为 "dm" 表示真人 DM） */
const IDENTITY_KEY = "jbs-identity";
export interface PlayerIdentity {
  [roomId: string]: { seatIndex: number | "dm"; token: string; name: string; code?: string; gameId?: string | null };
}
export function getIdentity(): PlayerIdentity {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "{}") as PlayerIdentity;
  } catch {
    return {};
  }
}
export function saveIdentity(
  roomId: string,
  seatIndex: number | "dm",
  token: string,
  name: string,
  extra?: { code?: string; gameId?: string | null }
): void {
  const all = getIdentity();
  const prev = all[roomId];
  all[roomId] = {
    seatIndex,
    token,
    name,
    code: extra?.code ?? prev?.code,
    gameId: extra?.gameId !== undefined ? extra.gameId : prev?.gameId,
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(all));
}

export function listIdentities(): Array<{ roomId: string } & PlayerIdentity[string]> {
  return Object.entries(getIdentity()).map(([roomId, v]) => ({ roomId, ...v }));
}

export function removeIdentity(roomId: string): void {
  const all = getIdentity();
  delete all[roomId];
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(all));
}

const HOST_KEY = "jbs-host";
export function getHostToken(code: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const all = JSON.parse(localStorage.getItem(HOST_KEY) ?? "{}") as Record<string, string>;
    return all[code] ?? null;
  } catch {
    return null;
  }
}
export function saveHostToken(code: string, token: string): void {
  const all = (() => {
    try {
      return JSON.parse(localStorage.getItem(HOST_KEY) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  })();
  all[code] = token;
  localStorage.setItem(HOST_KEY, JSON.stringify(all));
}

export function listHostCodes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return Object.keys(JSON.parse(localStorage.getItem(HOST_KEY) ?? "{}") as Record<string, string>);
  } catch {
    return [];
  }
}

export function removeHostToken(code: string): void {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(localStorage.getItem(HOST_KEY) ?? "{}") as Record<string, string>;
    delete all[code];
    localStorage.setItem(HOST_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
