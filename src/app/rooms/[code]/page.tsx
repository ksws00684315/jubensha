"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, getHostToken, getIdentity, saveIdentity, type RoomView } from "@/lib/client";

export default function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [room, setRoom] = useState<RoomView | null>(null);
  const [identity, setIdentity] = useState<ReturnType<typeof getIdentity>>({});
  const [joinName, setJoinName] = useState("");
  const [dmName, setDmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostToken, setHostToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<RoomView>(`/api/rooms/${code}`);
    setRoom(r);
    setIdentity(getIdentity());
    setHostToken(getHostToken(code));
  }, [code]);

  useEffect(() => {
    void Promise.resolve().then(() => load());
    const t = setInterval(() => void Promise.resolve().then(() => load()), 2500);
    return () => clearInterval(t);
  }, [load]);

  const join = async () => {
    if (!room) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ seatIndex: number; token: string }>("/api/rooms/join", {
        method: "POST",
        body: JSON.stringify({ code: room.code, name: joinName.trim() }),
      });
      saveIdentity(room.id, res.seatIndex, res.token, joinName.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const joinDm = async () => {
    if (!room) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ roomId: string; token: string }>("/api/rooms/dm-join", {
        method: "POST",
        body: JSON.stringify({ code: room.code, name: dmName.trim() }),
      });
      saveIdentity(res.roomId, "dm", res.token, dmName.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const updateSeat = async (index: number, kind: string) => {
    if (!room || !hostToken) return;
    setBusy(true);
    setError(null);
    try {
      const seats = room.seats.map((s) => ({ index: s.index, kind: s.index === index ? (kind as "ai" | "human" | "empty") : s.kind, characterId: s.character?.id ?? null }));
      await api(`/api/rooms/${room.code}`, { method: "PATCH", body: JSON.stringify({ seats, hostToken }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!room) return;
    if (!hostToken) {
      setError("只有创建房间的人可以开局");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ gameId: string }>(`/api/rooms/${room.code}/start`, { method: "POST", body: JSON.stringify({ hostToken }) });
      router.push(`/play/${res.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (!room) return <p className="text-zinc-500">加载房间…</p>;
  const my = identity[room.id];
  const openHumanSeat = room.seats.find((s) => s.kind === "human" && !s.hasToken);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{room.script.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">{room.script.intro}</p>
        </div>
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-6 py-4 text-center">
          <p className="text-xs text-zinc-400">房间码</p>
          <p className="font-mono text-3xl font-bold tracking-[0.3em] text-amber-400">{room.code}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-300">座位</h3>
        {room.seats.map((s) => {
          const isMe = my?.seatIndex === s.index;
          return (
            <div key={s.index} className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${isMe ? "border-amber-500/50 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/40"}`}>
              <span className="w-14 text-sm text-zinc-500">座位 {s.index + 1}</span>
              {room.status === "lobby" && hostToken ? (
                <select value={s.kind} onChange={(e) => void updateSeat(s.index, e.target.value)} disabled={busy} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-500">
                  <option value="ai">AI 玩家</option>
                  <option value="human">真人玩家</option>
                  <option value="empty">空座</option>
                </select>
              ) : (
                <span className="text-sm text-zinc-400">{s.kind === "ai" ? "AI" : s.kind === "human" ? "真人" : "空座"}</span>
              )}
              <span className="flex-1 text-sm">
                {s.character ? <span className="text-zinc-200">{s.character.name}</span> : <span className="text-zinc-600">未分配</span>}
                {s.playerName && <span className="ml-2 text-xs text-zinc-500">{s.playerName}{isMe ? "（你）" : ""}</span>}
              </span>
            </div>
          );
        })}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {room.humanDm && (
        <div className="rounded-xl border border-purple-500/40 bg-purple-500/5 p-5">
          <h4 className="text-sm font-medium text-purple-300">真人 DM 模式</h4>
          {(() => {
            const meIsDm = my?.seatIndex === "dm";
            if (meIsDm) return <p className="mt-2 text-sm text-zinc-300">你是本局的真人 DM（{my?.name}），进入对局后可见全部真相与私聊，并可随时旁白、催促或跳过卡住的回合。</p>;
            if (room.dmTaken) return <p className="mt-2 text-sm text-zinc-400">DM 已由「{room.dmName}」担任。</p>;
            if (room.status !== "lobby") return <p className="mt-2 text-sm text-zinc-400">对局已开始，DM 位不可再加入。</p>;
            return (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-zinc-400">本房间由真人担任 DM，认领后进入对局可全知视角主持。</p>
                <div className="flex gap-2">
                  <input
                    value={dmName}
                    onChange={(e) => setDmName(e.target.value)}
                    placeholder="DM 昵称"
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-purple-500"
                  />
                  <button onClick={joinDm} disabled={busy || !dmName.trim()} className="rounded-lg bg-purple-500/80 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-purple-400 disabled:opacity-40">
                    以 DM 身份就位
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {room.status === "lobby" ? (
        <div className="space-y-4">
          {openHumanSeat && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h4 className="text-sm font-medium text-zinc-300">还有空真人座位，坐进来？</h4>
              <div className="mt-3 flex gap-2">
                <input
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  placeholder="你的昵称"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500"
                />
                <button onClick={join} disabled={busy || !joinName.trim()} className="rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40">
                  入座
                </button>
              </div>
            </div>
          )}
          {hostToken ? (
            <button
              onClick={start}
              disabled={busy || !room.seats.every((s) => s.kind === "empty" || s.character)}
              className="rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
            >
              开始游戏（{room.seats.filter((s) => s.kind !== "empty").length} 人）
            </button>
          ) : (
            <p className="text-sm text-zinc-500">等待房主开局。入座后请留在此页。</p>
          )}
        </div>
      ) : (
        <button onClick={() => room.gameId && router.push(`/play/${room.gameId}`)} className="rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-zinc-950 hover:bg-amber-400">
          进入对局 →
        </button>
      )}
    </div>
  );
}
