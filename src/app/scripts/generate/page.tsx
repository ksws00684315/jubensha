"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

interface Outline {
  title?: string;
  characters?: Array<{ name?: string; isCulprit?: boolean; secretIdea?: string }>;
  [k: string]: unknown;
}

export default function GeneratePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    theme: "现代都市悬疑",
    playerCount: 5,
    difficulty: "新手" as "新手" | "进阶" | "硬核",
    trickType: "本格诡计（不用超自然）",
    extra: "",
  });
  const [outline, setOutline] = useState<Outline | null>(null);
  const [docText, setDocText] = useState("");
  const [stage, setStage] = useState<"form" | "outline" | "edit">("form");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      setStatus("第 1/2 步：正在构思剧本骨架（案件、角色、时间线）…");
      const r1 = await api<{ outline: Outline }>("/api/scripts/generate", {
        method: "POST",
        body: JSON.stringify({ stage: 1, ...form }),
      });
      setOutline(r1.outline);

      setStatus("第 2/2 步：正在展开完整剧本（角色卡、线索链、真相复盘）…约需 1-2 分钟");
      const r2 = await api<{ doc: unknown; issues?: Array<{ level: string; message: string }> }>("/api/scripts/generate", {
        method: "POST",
        body: JSON.stringify({ stage: 2, outline: r1.outline, ...form }),
      });
      setDocText(JSON.stringify(r2.doc, null, 2));
      const warns = (r2.issues ?? []).filter((i) => i.level === "warning").map((i) => i.message);
      setIssues(warns);
      setStage("edit");
      setStatus("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 结构校验失败（422）也进入编辑态，让用户手工修正
      if (msg.includes("未通过结构校验")) {
        setError(msg + "（可在下方 JSON 中手工修正后入库）");
        try {
          const res = await fetch("/api/scripts/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: 2, outline, ...form }),
          });
          const data = (await res.json()) as { doc?: unknown };
          if (data.doc) {
            setDocText(JSON.stringify(data.doc, null, 2));
            setStage("edit");
            setStatus("");
            return;
          }
        } catch {
          /* ignore */
        }
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const doc = JSON.parse(docText);
      const res = await api<{ id: string }>("/api/scripts", { method: "POST", body: JSON.stringify({ doc, source: "ai" }) });
      router.push(`/scripts/${res.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI 生成剧本</h1>
        <p className="mt-1 text-sm text-zinc-500">
          两阶段生成：先构思案件骨架，再展开完整剧本。生成后可手工编辑 JSON 再入库。需在「设置 → 模型绑定」配置「剧本生成」槽位。
        </p>
      </div>

      {stage === "form" && (
        <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-zinc-400">
              题材
              <input value={form.theme} onChange={(e) => setForm((f) => ({ ...f, theme: e.target.value }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
            </label>
            <label className="text-sm text-zinc-400">
              玩家人数
              <select value={form.playerCount} onChange={(e) => setForm((f) => ({ ...f, playerCount: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500">
                {[4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} 人
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-zinc-400">
              难度
              <select value={form.difficulty} onChange={(e) => setForm((f) => ({ ...f, difficulty: e.target.value as typeof form.difficulty }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500">
                {["新手", "进阶", "硬核"].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-zinc-400">
              诡计偏好
              <input value={form.trickType} onChange={(e) => setForm((f) => ({ ...f, trickType: e.target.value }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
            </label>
          </div>
          <label className="block text-sm text-zinc-400">
            其他要求（可选）
            <textarea value={form.extra} onChange={(e) => setForm((f) => ({ ...f, extra: e.target.value }))} rows={3} placeholder="例如：民国背景、山庄密室、情感线…" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {outline && (
            <details className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-500">
              <summary className="cursor-pointer">查看骨架</summary>
              <pre className="mt-2 overflow-auto">{JSON.stringify(outline, null, 2)}</pre>
            </details>
          )}
          <button onClick={generate} disabled={busy} className="rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">
            {busy ? "生成中…" : "开始生成"}
          </button>
          {busy && <p className="animate-pulse text-sm text-amber-400">{status}</p>}
        </div>
      )}

      {stage === "edit" && (
        <div className="space-y-4">
          {issues.length > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-400/90">
              {issues.map((w, i) => (
                <p key={i}>警告 · {w}</p>
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <textarea
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
            rows={24}
            className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-4 font-mono text-xs outline-none focus:border-amber-500"
          />
          <div className="flex gap-3">
            <button onClick={save} disabled={busy} className="rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40">
              {busy ? "校验入库中…" : "校验并入库"}
            </button>
            <button onClick={() => setStage("form")} className="rounded-lg border border-zinc-700 px-6 py-2.5 text-sm hover:border-zinc-500">
              返回重新生成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
