"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, saveIdentity } from "@/lib/client";

export default function JoinBox() {
  const router = useRouter();
  const [code, setName] = useState({ code: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setError(null);
    setBusy(true);
    try {
      const roomCode = code.code.trim().toUpperCase();
      const name = code.name.trim();
      const res = await api<{
        roomId: string;
        seatIndex: number;
        token: string;
        gameId: string | null;
        resumed: boolean;
      }>("/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: roomCode, name }),
      });
      saveIdentity(res.roomId, res.seatIndex, res.token, name, { code: roomCode, gameId: res.gameId });
      if (res.gameId) {
        router.push(`/play/${res.gameId}`);
      } else {
        router.push(`/rooms/${roomCode}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="surface-panel w-full max-w-xl p-5 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium text-paper-50">加入房间</h3>
          <p className="mt-1 text-sm text-paper-500">有房间码？直接入座。断线后用原昵称即可回到座位。</p>
        </div>
        <span className="rounded-full border border-success-400/20 bg-success-400/5 px-2.5 py-1 text-[10px] font-semibold tracking-widest text-success-400">
          READY
        </span>
      </div>
      <div className="mt-4 space-y-3">
        <input
          value={code.code}
          onChange={(e) => setName((s) => ({ ...s, code: e.target.value.toUpperCase() }))}
          placeholder="房间码，如 7KX3M"
          maxLength={6}
          className="w-full rounded-lg border border-gold-400/15 bg-ink-950/80 px-3 py-2.5 font-mono text-lg tracking-widest text-paper-50 outline-none placeholder:text-paper-500 focus:border-gold-400"
        />
        <input
          value={code.name}
          onChange={(e) => setName((s) => ({ ...s, name: e.target.value }))}
          placeholder="你的昵称（断线重连请填原名）"
          maxLength={20}
          className="w-full rounded-lg border border-gold-400/15 bg-ink-950/80 px-3 py-2.5 text-sm text-paper-50 outline-none placeholder:text-paper-500 focus:border-gold-400"
        />
        {error && <p className="text-sm text-danger-400">{error}</p>}
        <button
          onClick={join}
          disabled={busy || !code.code.trim() || !code.name.trim()}
          className="w-full rounded-lg bg-gold-500 py-2.5 font-semibold text-ink-950 transition hover:bg-gold-400 disabled:opacity-40"
        >
          {busy ? "正在加入…" : "入座 / 回到本局"}
        </button>
      </div>
    </div>
  );
}
