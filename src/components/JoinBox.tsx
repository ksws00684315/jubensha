"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, saveIdentity, type RoomView } from "@/lib/client";

export default function JoinBox() {
  const router = useRouter();
  const [code, setName] = useState({ code: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ roomId: string; seatIndex: number; token: string }>("/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: code.code.trim(), name: code.name.trim() }),
      });
      saveIdentity(res.roomId, res.seatIndex, res.token, code.name.trim());
      const room = await api<RoomView>(`/api/rooms/${code.code.trim().toUpperCase()}`);
      if (room.gameId) {
        router.push(`/play/${room.gameId}`);
      } else {
        router.push(`/rooms/${room.code}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <h3 className="font-medium">加入房间</h3>
      <p className="mt-1 text-sm text-zinc-500">有房间码？直接入座。</p>
      <div className="mt-4 space-y-3">
        <input
          value={code.code}
          onChange={(e) => setName((s) => ({ ...s, code: e.target.value.toUpperCase() }))}
          placeholder="房间码，如 7KX3M"
          maxLength={6}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-lg tracking-widest outline-none placeholder:text-zinc-600 focus:border-amber-500"
        />
        <input
          value={code.name}
          onChange={(e) => setName((s) => ({ ...s, name: e.target.value }))}
          placeholder="你的昵称"
          maxLength={20}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          onClick={join}
          disabled={busy || !code.code.trim() || !code.name.trim()}
          className="w-full rounded-lg bg-amber-500 py-2 font-medium text-zinc-950 transition hover:bg-amber-400 disabled:opacity-40"
        >
          {busy ? "正在加入…" : "入座"}
        </button>
      </div>
    </div>
  );
}
