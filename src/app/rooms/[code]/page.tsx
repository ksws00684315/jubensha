"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const loadedRef = useRef(false);

  const load = useCallback(async () => {
    const stored = Object.values(getIdentity()).find((value) => value.code?.toUpperCase() === code.toUpperCase());
    const query = new URLSearchParams();
    const headers: Record<string, string> = {};
    const host = getHostToken(code);
    if (host) headers["x-host-token"] = host;
    if (stored?.seatIndex === "dm") {
      headers["x-dm-token"] = stored.token;
    } else if (stored) {
      query.set("seat", String(stored.seatIndex));
      headers["x-seat-token"] = stored.token;
    }
    let r: RoomView;
    try {
      r = await api<RoomView>(`/api/rooms/${code}${query.size ? `?${query}` : ""}`, { headers });
    } catch (err) {
      // 首载失败要可见可重试；轮询抖动保持静默，避免闪断横幅干扰大厅操作
      if (!loadedRef.current) setError(err instanceof Error ? err.message : String(err));
      return;
    }
    loadedRef.current = true;
    const mine = getIdentity()[r.id];
    if (mine) saveIdentity(r.id, mine.seatIndex, mine.token, mine.name, { code: r.code, gameId: r.gameId });
    setRoom(r);
    setIdentity(getIdentity());
    setHostToken(getHostToken(code));
  }, [code]);

  useEffect(() => {
    void Promise.resolve().then(() => load());
    const t = setInterval(() => {
      if (document.hidden) return; // 页面不可见时暂停轮询，回到前台由下个周期恢复
      void Promise.resolve().then(() => load());
    }, 2500);
    return () => clearInterval(t);
  }, [load]);

  const persistSeat = (
    roomId: string,
    seatIndex: number | "dm",
    token: string,
    name: string,
    gameId: string | null,
    roomCode: string
  ) => {
    saveIdentity(roomId, seatIndex, token, name, { code: roomCode, gameId });
    setIdentity(getIdentity());
  };

  const enterGame = (gameId: string | null) => {
    if (!gameId || !room) return;
    const mine = getIdentity()[room.id];
    if (mine) persistSeat(room.id, mine.seatIndex, mine.token, mine.name, gameId, room.code);
    router.push(`/play/${gameId}`);
  };

  const join = async () => {
    if (!room) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ seatIndex: number; token: string; gameId: string | null; resumed: boolean }>(
        "/api/rooms/join",
        {
          method: "POST",
          body: JSON.stringify({
            code: room.code,
            name: joinName.trim(),
            token: my?.seatIndex !== "dm" ? my?.token : undefined,
            hostToken: hostToken ?? undefined,
          }),
        }
      );
      persistSeat(room.id, res.seatIndex, res.token, joinName.trim(), res.gameId, room.code);
      if (res.gameId && room.status !== "lobby") {
        router.push(`/play/${res.gameId}`);
        return;
      }
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
      const res = await api<{ roomId: string; token: string; gameId: string | null; resumed: boolean }>(
        "/api/rooms/dm-join",
        {
          method: "POST",
          body: JSON.stringify({ code: room.code, name: dmName.trim(), token: my?.seatIndex === "dm" ? my.token : undefined, hostToken: hostToken ?? undefined }),
        }
      );
      persistSeat(res.roomId, "dm", res.token, dmName.trim(), res.gameId, room.code);
      if (res.gameId && room.status !== "lobby") {
        router.push(`/play/${res.gameId}`);
        return;
      }
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
      const mine = getIdentity()[room.id];
      if (mine) persistSeat(room.id, mine.seatIndex, mine.token, mine.name, res.gameId, room.code);
      router.push(`/play/${res.gameId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  if (!room)
    return error ? (
      <div className="mx-auto mt-16 max-w-md space-y-4 rounded-xl border border-danger-400/40 bg-danger-400/5 p-6 text-center">
        <p className="text-sm text-danger-400">房间加载失败：{error}</p>
        <button
          onClick={() => {
            setError(null);
            void Promise.resolve().then(() => load());
          }}
          className="rounded-lg bg-gold-400 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-gold-300"
        >
          重试
        </button>
      </div>
    ) : (
      <p className="text-paper-400">加载房间…</p>
    );
  const my = identity[room.id];
  const openHumanSeat = room.seats.find((s) => s.kind === "human" && !s.hasToken);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{room.script.title}</h1>
          <p className="mt-1 text-sm text-paper-400">{room.script.intro}</p>
        </div>
        <div className="rounded-xl border border-gold-400/40 bg-gold-400/5 px-6 py-4 text-center">
          <p className="text-xs text-paper-300">房间码</p>
          <p className="font-mono text-3xl font-bold tracking-[0.3em] text-gold-400">{room.code}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-paper-200">座位</h3>
        {room.seats.map((s) => {
          const isMe = my?.seatIndex === s.index;
          return (
            <div key={s.index} className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 ${isMe ? "border-gold-400/50 bg-gold-400/5" : "border-gold-400/12 bg-ink-900/50"}`}>
              <span className="w-14 text-sm text-paper-400">座位 {s.index + 1}</span>
              {room.status === "lobby" && hostToken ? (
                <select aria-label={`座位 ${s.index + 1} 的安排`} value={s.kind} onChange={(e) => void updateSeat(s.index, e.target.value)} disabled={busy} className="rounded-lg border border-gold-400/25 bg-ink-950 px-2 py-1.5 text-sm outline-none focus:border-gold-400">
                  <option value="ai">AI 玩家</option>
                  <option value="human">真人玩家</option>
                  <option value="empty">空座</option>
                </select>
              ) : (
                <span className="text-sm text-paper-300">{s.kind === "ai" ? "AI" : s.kind === "human" ? "真人" : "空座"}</span>
              )}
              <span className="flex-1 text-sm">
                {s.character ? <span className="text-paper-200">{s.character.name}</span> : <span className="text-paper-400">未分配</span>}
                {s.playerName && s.kind !== "ai" && <span className="ml-2 text-xs text-paper-400">{s.playerName}{isMe ? "（你）" : ""}</span>}
              </span>
            </div>
          );
        })}
      </div>

      {error && <p className="text-sm text-danger-400">{error}</p>}

      {room.humanDm && (
        <div className="rounded-xl border border-secret-400/40 bg-secret-400/5 p-5">
          <h4 className="text-sm font-medium text-secret-400">真人 DM 模式</h4>
          {(() => {
            const meIsDm = my?.seatIndex === "dm";
            if (meIsDm) {
              return (
                <p className="mt-2 text-sm text-paper-200">
                  你是本局的真人 DM（{my?.name}），进入对局后可见全部真相与私聊，并可随时旁白、催促或跳过卡住的回合。
                </p>
              );
            }
            const reclaim = room.dmTaken || room.status !== "lobby";
            return (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-paper-300">
                  {reclaim
                    ? `DM 已有人担任。若是你本人，请使用原设备凭证恢复，或请房主确认。`
                    : "本房间由真人担任 DM，认领后进入对局可全知视角主持。"}
                </p>
                <div className="flex gap-2">
                  <input
                    aria-label="DM 昵称"
                    value={dmName}
                    onChange={(e) => setDmName(e.target.value)}
                    placeholder={reclaim ? "认领时用的昵称" : "DM 昵称"}
                    className="flex-1 rounded-lg border border-gold-400/25 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-secret-400"
                  />
                  <button
                    onClick={joinDm}
                    disabled={busy || !dmName.trim()}
                    className="rounded-lg bg-secret-400/80 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-secret-400 disabled:opacity-40"
                  >
                    {reclaim ? "认领 DM" : "以 DM 身份就位"}
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {room.status === "lobby" ? (
        <div className="space-y-4">
          {(openHumanSeat || !my) && (
            <div className="rounded-xl border border-gold-400/12 bg-ink-900/60 p-5">
              <h4 className="text-sm font-medium text-paper-200">
                {openHumanSeat ? "还有空真人座位，坐进来？" : "用原昵称认领已入座的位置"}
              </h4>
              <div className="mt-3 flex gap-2">
                <input
                  aria-label="你的昵称"
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  placeholder="你的昵称"
                  className="flex-1 rounded-lg border border-gold-400/25 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-gold-400"
                />
                <button onClick={join} disabled={busy || !joinName.trim()} className="rounded-lg bg-gold-400 px-4 py-2 text-sm text-ink-950 hover:bg-gold-300 disabled:opacity-40">
                  入座
                </button>
              </div>
            </div>
          )}
          {hostToken ? (
            <button
              onClick={start}
              disabled={busy || !room.seats.every((s) => s.kind === "empty" || s.character)}
              className="rounded-lg bg-gold-400 px-6 py-2.5 font-medium text-ink-950 hover:bg-gold-300 disabled:opacity-40"
            >
              开始游戏（{room.seats.filter((s) => s.kind !== "empty").length} 人）
            </button>
          ) : (
            <p className="text-sm text-paper-400">等待房主开局。入座后请留在此页。</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {my ? (
            <button
              onClick={() => enterGame(room.gameId)}
              disabled={!room.gameId}
              className="rounded-lg bg-gold-400 px-6 py-2.5 font-medium text-ink-950 hover:bg-gold-300 disabled:opacity-40"
            >
              进入对局 →
            </button>
          ) : (
            <div className="rounded-xl border border-gold-400/12 bg-ink-900/60 p-5">
              <h4 className="text-sm font-medium text-paper-200">回到本局</h4>
              <p className="mt-1 text-sm text-paper-400">对局已开始。请使用原设备凭证恢复，或让房主用房主凭证确认。</p>
              <div className="mt-3 flex gap-2">
                <input
                  aria-label="入座时用的昵称"
                  value={joinName}
                  onChange={(e) => setJoinName(e.target.value)}
                  placeholder="入座时用的昵称"
                  className="flex-1 rounded-lg border border-gold-400/25 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-gold-400"
                />
                <button
                  onClick={join}
                  disabled={busy || !joinName.trim()}
                  className="rounded-lg bg-gold-400 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-gold-300 disabled:opacity-40"
                >
                  认领并进入
                </button>
              </div>
            </div>
          )}
          {hostToken && !my && room.gameId && (
            <button
              onClick={() => enterGame(room.gameId)}
              className="text-sm text-paper-400 hover:text-paper-200"
            >
              以观众身份观看 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
