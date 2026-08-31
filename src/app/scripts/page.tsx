"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type ScriptSummary } from "@/lib/client";

export default function ScriptsPage() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setScripts(await api<ScriptSummary[]>("/api/scripts"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, []);

  const doImport = async () => {
    setBusy(true);
    setImportMsg(null);
    try {
      const doc = JSON.parse(importText);
      const res = await api<{ id: string; issues: Array<{ level: string; message: string }> }>("/api/scripts", {
        method: "POST",
        body: JSON.stringify({ doc, source: "import" }),
      });
      const warns = (res.issues ?? []).filter((i) => i.level === "warning");
      setImportMsg({
        ok: true,
        text: `导入成功${warns.length ? `，有 ${warns.length} 条优化建议` : ""}。`,
      });
      setImportText("");
      setImportOpen(false);
      await load();
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    setImportText(text);
    setImportOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">剧本库</h1>
          <p className="mt-1 text-sm text-zinc-500">管理可开局的剧本。支持 JSON 导入导出；内置剧本均为原创内容。</p>
        </div>
        <div className="flex gap-3">
          <label className="cursor-pointer rounded-lg border border-zinc-700 px-4 py-2 text-sm transition hover:border-zinc-500">
            导入 JSON
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
          <Link
            href="/scripts/generate"
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-amber-400 transition hover:border-amber-500/50"
          >
            AI 生成剧本
          </Link>
        </div>
      </div>

      {importMsg && (
        <p className={`text-sm ${importMsg.ok ? "text-emerald-400" : "text-red-400"}`}>
          {importMsg.text} {!importMsg.ok && "请检查 JSON 格式与剧本校验规则（真凶标记、线索地点等）。"}
        </p>
      )}

      {loading ? (
        <p className="text-zinc-500">加载中…</p>
      ) : scripts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-zinc-500">
          剧本库还是空的。导入一个 JSON 剧本，或用 AI 生成一个。
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {scripts.map((s) => (
            <Link
              key={s.id}
              href={`/scripts/${s.id}`}
              className="group rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition hover:border-amber-500/40"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold group-hover:text-amber-400">{s.title}</h3>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{s.difficulty}</span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-zinc-400">{s.intro}</p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-500">
                <span>
                  {s.minPlayers === s.maxPlayers ? `${s.minPlayers} 人` : `${s.minPlayers}-${s.maxPlayers} 人`}
                </span>
                <span>·</span>
                <span>约 {s.durationMin} 分钟</span>
                {s.tags.slice(0, 3).map((t) => (
                  <span key={t} className="rounded bg-zinc-800/80 px-1.5">
                    {t}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}

      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <h3 className="font-semibold">粘贴剧本文档 JSON</h3>
            <p className="mt-1 text-xs text-zinc-500">仅支持本系统 Schema 结构；商用剧本受版权保护，请仅导入自创或已授权内容。</p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={14}
              placeholder='{"version":1,"meta":{...}}'
              className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs outline-none focus:border-amber-500"
            />
            {importMsg && !importMsg.ok && <p className="mt-2 text-sm text-red-400">{importMsg.text}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <button onClick={() => setImportOpen(false)} className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200">
                取消
              </button>
              <button
                onClick={doImport}
                disabled={busy || !importText.trim()}
                className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
              >
                {busy ? "校验中…" : "校验并导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
