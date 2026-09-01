"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, saveHostToken, type ScriptSummary } from "@/lib/client";
import { assignCharacterIds } from "@/lib/seats";

interface ScriptMeta {
  id: string;
  title: string;
  intro: string;
  minPlayers: number;
  maxPlayers: number;
  characters: Array<{ id: string; name: string; publicBio: string }>;
}

type SeatKind = "ai" | "human" | "empty";

export default function NewRoomPage() {
  return (
    <Suspense fallback={<p className="text-zinc-500">加载中…</p>}>
      <NewRoomContent />
    </Suspense>
  );
}

function NewRoomContent() {
  const router = useRouter();
  const search = useSearchParams();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState(search.get("scriptId") ?? "");
  const [doc, setDoc] = useState<ScriptMeta | null>(null);
  const [seats, setSeats] = useState<Array<{ kind: SeatKind; characterId: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [humanDm, setHumanDm] = useState(false);
  const [unlimitedHumanTurns, setUnlimitedHumanTurns] = useState(true);

  useEffect(() => {
    void api<ScriptSummary[]>("/api/scripts").then((list) => {
      setScripts(list);
      if (!search.get("scriptId") && list[0]) setScriptId(list[0].id);
    });
  }, [search]);

  useEffect(() => {
    if (!scriptId) return;
    void api<ScriptMeta>(`/api/scripts/${scriptId}/meta`).then((res) => {
      setDoc(res);
      setSeats(Array.from({ length: res.maxPlayers }, () => ({ kind: "ai" as SeatKind, characterId: null })));
    });
  }, [scriptId]);

  const characterIds = useMemo(() => doc?.characters.map((c) => c.id) ?? [], [doc]);

  const usedIds = useMemo(() => new Set(seats.map((s) => s.characterId).filter(Boolean) as string[]), [seats]);
  const previewIds = useMemo(() => assignCharacterIds(seats, characterIds), [seats, characterIds]);

  const activeCount = seats.filter((s) => s.kind !== "empty").length;
  const canCreate =
    doc && activeCount >= doc.minPlayers && activeCount <= doc.maxPlayers && seats[0]?.kind !== "empty";

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = seats.map((s) => ({
        kind: s.kind,
        characterId: s.kind === "empty" ? null : s.characterId,
      }));
      // 去掉尾部连续空座
      while (payload.length && payload[payload.length - 1].kind === "empty") payload.pop();
      const res = await api<{ code: string; hostToken: string }>("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ scriptId, seats: payload, humanDm, unlimitedHumanTurns }),
      });
      saveHostToken(res.code, res.hostToken);
      router.push(`/rooms/${res.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!doc) return <p className="text-zinc-500">加载剧本…</p>;
  const charName = (id: string | null) => doc.characters.find((c) => c.id === id)?.name ?? "自动分配";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">创建房间</h1>
        <p className="mt-1 text-sm text-zinc-500">选择剧本，为每个座位指定 AI 或真人。真人座位创建后凭房间码入座。</p>
      </div>

      <label className="block text-sm text-zinc-400">
        剧本
        <select value={scriptId} onChange={(e) => setScriptId(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-amber-500">
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}（{s.minPlayers === s.maxPlayers ? `${s.minPlayers} 人` : `${s.minPlayers}-${s.maxPlayers} 人`}）
            </option>
          ))}
        </select>
      </label>

      {doc && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">
          <span className="font-medium text-zinc-200">{doc.title}</span> · {doc.intro}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">座位配置（{activeCount} 个活跃座位）</h3>
          <p className="text-xs text-zinc-500">
            需要 {doc.minPlayers}-{doc.maxPlayers} 人；座位 0 为房主位
          </p>
        </div>
        {seats.map((seat, i) => (
          <div key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
            <span className="w-14 text-sm text-zinc-500">座位 {i + 1}</span>
            <select
              value={seat.kind}
              onChange={(e) => setSeats((s) => s.map((x, j) => (j === i ? { ...x, kind: e.target.value as SeatKind } : x)))}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-500"
            >
              <option value="ai">AI 玩家</option>
              <option value="human">真人玩家</option>
              <option value="empty">空座</option>
            </select>
            {seat.kind !== "empty" && (
              <select
                value={seat.characterId ?? ""}
                onChange={(e) => setSeats((s) => s.map((x, j) => (j === i ? { ...x, characterId: e.target.value || null } : x)))}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-500"
              >
                <option value="">自动分配角色</option>
                {characterIds.map((id) => (
                  <option key={id} value={id} disabled={usedIds.has(id) && seat.characterId !== id}>
                    {doc.characters.find((c) => c.id === id)?.name}
                  </option>
                ))}
              </select>
            )}
            {seat.kind !== "empty" && <span className="text-xs text-zinc-500">→ {charName(seat.characterId ?? previewIds[i] ?? null)}</span>}
          </div>
        ))}
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-purple-500/30 bg-purple-500/5 p-4 text-sm">
        <input type="checkbox" checked={humanDm} onChange={(e) => setHumanDm(e.target.checked)} className="mt-0.5" />
        <span>
          <span className="font-medium text-purple-200">启用真人 DM</span>
          <span className="mt-1 block text-xs text-zinc-500">开局后由一位真人负责旁白、催促和跳过回合，并可查看完整真相。</span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
        <input
          type="checkbox"
          checked={unlimitedHumanTurns}
          onChange={(e) => setUnlimitedHumanTurns(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-zinc-200">真人操作不限时</span>
          <span className="mt-1 block text-xs text-zinc-500">
            勾选后，真人发言、搜证、投票都一直等到本人操作。取消勾选则 3 分钟无操作会自动跳过，避免整局卡住。
          </span>
        </span>
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        onClick={create}
        disabled={busy || !canCreate}
        className="rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
      >
        {busy ? "创建中…" : "创建房间"}
      </button>
    </div>
  );
}
