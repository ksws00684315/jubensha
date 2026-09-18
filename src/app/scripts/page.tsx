"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type ScriptSummary } from "@/lib/client";
import { Button } from "@/components/ui";

export default function ScriptsPage() {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

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

  // 弹窗焦点管理：打开即聚焦文本域，Esc 关闭，Tab 在面板内循环（焦点圈定），关闭后焦点还给触发元素
  useEffect(() => {
    if (!importOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = dialogRef.current;
    el?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setImportOpen(false);
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const focusables = el.querySelectorAll<HTMLElement>("textarea, button:not([disabled])");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [importOpen]);

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">剧本库</h1>
          <p className="mt-1 text-sm text-paper-400">管理可开局的剧本。支持 JSON 导入导出；内置剧本均为原创内容。</p>
        </div>
        <div className="flex gap-3">
          <label className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-gold-400/30 px-4 py-2 text-sm text-gold-300 transition hover:bg-gold-400/10 focus-within:border-gold-400 focus-within:ring-1 focus-within:ring-gold-400/40">
            导入 JSON
            <input
              type="file"
              accept=".json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
          </label>
          <Link
            href="/scripts/generate"
            className="inline-flex items-center justify-center rounded-lg bg-gold-400 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-gold-300"
          >
            AI 生成剧本
          </Link>
        </div>
      </div>

      {importMsg && (
        <p className={`text-sm ${importMsg.ok ? "text-success-400" : "text-danger-400"}`} role="status">
          {importMsg.text} {!importMsg.ok && "请检查 JSON 格式与剧本校验规则（真凶标记、线索地点等）。"}
        </p>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="剧本加载中" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-40 rounded-xl" />
          ))}
        </div>
      ) : scripts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gold-400/20 p-12 text-center text-paper-400">
          剧本库还是空的。导入一个 JSON 剧本，或用 AI 生成一个。
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {scripts.map((s) => (
            <Link
              key={s.id}
              href={`/scripts/${s.id}`}
              className="group rounded-xl border border-gold-400/12 bg-ink-900/60 p-5 transition hover:border-gold-400/45"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold group-hover:text-gold-300">{s.title}</h3>
                <span className="rounded bg-ink-800 px-2 py-0.5 text-xs text-paper-300">{s.difficulty}</span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-paper-300">{s.intro}</p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-paper-400">
                <span>
                  {s.minPlayers === s.maxPlayers ? `${s.minPlayers} 人` : `${s.minPlayers}-${s.maxPlayers} 人`}
                </span>
                <span>·</span>
                <span>约 {s.durationMin} 分钟</span>
                {s.tags.slice(0, 3).map((t) => (
                  <span key={t} className="rounded bg-ink-800/80 px-1.5">
                    {t}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}

      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setImportOpen(false)}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-json-title"
            className="w-full max-w-2xl rounded-xl border border-gold-400/20 bg-ink-900 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="import-json-title" className="font-semibold">粘贴剧本文档 JSON</h3>
            <p className="mt-1 text-xs text-paper-400">仅支持本系统 Schema 结构；商用剧本受版权保护，请仅导入自创或已授权内容。</p>
            <label className="sr-only" htmlFor="import-json-textarea">
              剧本文档 JSON 内容
            </label>
            <textarea
              id="import-json-textarea"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={14}
              placeholder='{"version":1,"meta":{...}}'
              className="mt-3 w-full rounded-lg border border-gold-400/20 bg-ink-950 p-3 font-mono text-xs text-paper-100 outline-none placeholder:text-paper-500 focus:border-gold-400/60"
            />
            {importMsg && !importMsg.ok && <p className="mt-2 text-sm text-danger-400">{importMsg.text}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setImportOpen(false)}>
                取消
              </Button>
              <Button onClick={doImport} disabled={busy || !importText.trim()}>
                {busy ? "校验中…" : "校验并导入"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
