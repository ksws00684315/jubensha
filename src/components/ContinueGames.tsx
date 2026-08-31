"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  api,
  listHostCodes,
  listIdentities,
  PHASE_LABEL,
  removeHostToken,
  removeIdentity,
  type RoomView,
} from "@/lib/client";

interface ContinueItem {
  roomId: string;
  code: string;
  title: string;
  status: string;
  gameId: string | null;
  gamePhase: string | null;
  name: string | null;
  seatLabel: string;
}

export default function ContinueGames() {
  const [items, setItems] = useState<ContinueItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const sessions = listIdentities();
    const codes = new Set<string>([
      ...sessions.map((s) => s.code).filter((c): c is string => Boolean(c)),
      ...listHostCodes(),
    ]);
    if (!codes.size) {
      setLoaded(true);
      return;
    }
    void Promise.all(
      [...codes].map(async (code) => {
        try {
          const room = await api<RoomView>(`/api/rooms/${code}`);
          const mine = sessions.find((s) => s.roomId === room.id || s.code === room.code);
          if (room.status !== "lobby" && room.status !== "playing") return null;
          const seatLabel =
            mine?.seatIndex === "dm" ? "DM" : typeof mine?.seatIndex === "number" ? `座位 ${mine.seatIndex + 1}` : "房主";
          return {
            roomId: room.id,
            code: room.code,
            title: room.script.title,
            status: room.status,
            gameId: room.gameId,
            gamePhase: room.gamePhase,
            name: mine?.name ?? null,
            seatLabel,
          } satisfies ContinueItem;
        } catch {
          return null;
        }
      })
    ).then((rows) => {
      setItems(rows.filter((r): r is ContinueItem => r !== null));
      setLoaded(true);
    });
  }, []);

  const dismiss = (item: ContinueItem) => {
    removeIdentity(item.roomId);
    removeHostToken(item.code);
    setItems((prev) => prev.filter((i) => i.roomId !== item.roomId));
  };

  if (!loaded || items.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-md space-y-3">
      <h3 className="text-sm font-medium text-zinc-300">继续对局</h3>
      {items.map((item) => {
        const href = item.gameId ? `/play/${item.gameId}` : `/rooms/${item.code}`;
        const phase =
          item.status === "playing" ? (PHASE_LABEL[item.gamePhase ?? ""] ?? "进行中") : "等待开局";
        return (
          <div
            key={item.roomId}
            className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-100">{item.title}</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {item.code} · {phase}
                {item.name ? ` · ${item.name}` : ""} · {item.seatLabel}
              </p>
            </div>
            <Link
              href={href}
              className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-amber-400"
            >
              {item.gameId ? "进入" : "回大厅"}
            </Link>
            <button
              type="button"
              onClick={() => dismiss(item)}
              className="shrink-0 text-xs text-zinc-600 hover:text-zinc-400"
            >
              忽略
            </button>
          </div>
        );
      })}
    </section>
  );
}
