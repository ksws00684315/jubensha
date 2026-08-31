"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import type { PublicScriptView, ScriptDoc } from "@/core/script/schema";

export default function ScriptDetail({
  id,
  publicDoc,
  source,
  updatedAt,
}: {
  id: string;
  publicDoc: PublicScriptView;
  source: string;
  updatedAt: string;
}) {
  const router = useRouter();
  const [dmView, setDmView] = useState(false);
  const [full, setFull] = useState<ScriptDoc | null>(null);
  const [issues, setIssues] = useState<Array<{ level: "error" | "warning"; message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = publicDoc.meta;

  const openDm = async () => {
    if (dmView) {
      setDmView(false);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ doc: ScriptDoc; issues: Array<{ level: "error" | "warning"; message: string }> }>(
        `/api/scripts/${id}?full=1`
      );
      setFull(res.doc);
      setIssues(res.issues ?? []);
      setDmView(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "需要管理员身份才能查看真相。请先到设置页解锁。");
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setError(null);
    const res = await fetch(`/api/scripts/${id}`, { method: "POST", credentials: "include" });
    if (!res.ok) {
      setError("导出失败：需要管理员身份");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.title}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const remove = async () => {
    if (!confirm(`确定删除剧本「${meta.title}」？`)) return;
    setBusy(true);
    try {
      await api(`/api/scripts/${id}`, { method: "DELETE" });
      router.push("/scripts");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{meta.title}</h1>
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{meta.difficulty}</span>
            <span className="text-xs text-zinc-500">
              {meta.minPlayers === meta.maxPlayers ? `${meta.minPlayers} 人` : `${meta.minPlayers}-${meta.maxPlayers} 人`} · 约{" "}
              {meta.durationMin} 分钟 · {source === "ai" ? "AI 生成" : source === "import" ? "导入" : "手工"}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">{meta.intro}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {meta.tags.map((t) => (
              <span key={t} className="rounded bg-zinc-800/80 px-2 py-0.5 text-xs text-zinc-400">
                {t}
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-600">更新于 {updatedAt.slice(0, 10)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => void openDm()}
            disabled={busy}
            className={`rounded-lg border px-4 py-2 text-sm transition ${
              dmView ? "border-red-500/60 text-red-400" : "border-zinc-700 text-zinc-300 hover:border-zinc-500"
            }`}
          >
            {dmView ? "返回公开视图" : "DM 视图（需管理身份）"}
          </button>
          <button onClick={() => void download()} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500">
            导出 JSON
          </button>
          <Link
            href={`/rooms/new?scriptId=${id}`}
            className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400"
          >
            用它开一局
          </Link>
          <button onClick={() => void remove()} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-red-400 disabled:opacity-40">
            删除
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {dmView && (errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-sm">
          {errors.map((e, i) => (
            <p key={`e${i}`} className="text-red-400">
              ✗ {e.message}
            </p>
          ))}
          {warnings.map((w, i) => (
            <p key={`w${i}`} className="text-amber-400/80">
              ⚠ {w.message}
            </p>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h2 className="font-semibold text-amber-400">公开背景</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{publicDoc.background}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {publicDoc.characters.map((c) => {
          const card = full?.characters.find((x) => x.id === c.id)?.card;
          return (
            <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  {c.name}
                  {c.gender ? <span className="ml-1 text-xs text-zinc-500">{c.gender}</span> : null}
                </h3>
                {dmView && card?.isCulprit && <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-400">真凶</span>}
              </div>
              <p className="mt-2 text-sm text-zinc-400">{c.publicBio}</p>
              {dmView && card && (
                <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
                  <p>
                    <span className="text-zinc-400">秘密：</span>
                    {card.secret}
                  </p>
                  <p>
                    <span className="text-zinc-400">目标：</span>
                    {card.goal}
                  </p>
                  <p>
                    <span className="text-zinc-400">时间线：</span>
                    {card.timeline}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {dmView && full && (
        <>
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6">
            <h2 className="font-semibold text-red-400">真相（仅 DM / 组织者可见）</h2>
            <p className="mt-2 text-sm text-zinc-300">
              <span className="text-zinc-500">真凶：</span>
              {full.characters.find((c) => c.id === full.truth.culprit)?.name}
            </p>
            <p className="mt-1 text-sm text-zinc-300">
              <span className="text-zinc-500">手法：</span>
              {full.truth.method}
            </p>
            <p className="mt-1 text-sm text-zinc-300">
              <span className="text-zinc-500">关键证据：</span>
              {full.truth.keyEvidence.join("、")}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-400">{full.truth.fullTimeline}</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="font-semibold">复盘底稿</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-400">{full.truth.reveal}</p>
            <p className="mt-2 text-sm text-zinc-500">{full.ending.winText}</p>
          </div>
        </>
      )}

      <div>
        <h2 className="font-semibold">
          线索卡{" "}
          <span className="text-sm text-zinc-500">
            共 {dmView && full ? full.clues.length : publicDoc.clueCount} 张 · 搜证地点：{publicDoc.locations.join("、")}
          </span>
        </h2>
        {dmView && full ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {full.clues.map((c) => (
              <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-zinc-500">
                    {c.policy === "auto_public" ? "自动公开" : c.policy === "keep_private" ? "必私藏" : "可公开"}
                  </span>
                </div>
                <p className="mt-2 text-zinc-400">{c.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">线索内容仅在搜证后或 DM 视图中可见。</p>
        )}
      </div>
    </div>
  );
}
