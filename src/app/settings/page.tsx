"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { BINDING_SLOTS, PROVIDER_PRESETS } from "@/lib/provider-presets";

interface ProviderView {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyMasked: string;
  enabled: boolean;
  note: string | null;
}
interface BindingView {
  slot: string;
  providerId: string;
  providerName: string;
  modelId: string;
  temperature: number | null;
  fallbackSlot: string | null;
  providerEnabled: boolean;
}
interface UsageView {
  summary: Array<{
    providerName: string;
    modelId: string;
    purpose: string;
    ok: boolean;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
  recentErrors: Array<{ providerName: string; modelId: string; purpose: string; error: string | null; createdAt: string }>;
}

const PURPOSE_LABEL: Record<string, string> = {
  dm: "DM 主持人",
  culprit: "凶手玩家",
  player: "普通 AI 玩家",
  generator: "剧本生成",
  tts: "语音合成",
};

function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "locked">("loading");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<{ admin: boolean }>("/api/admin/unlock")
      .then((r) => setState(r.admin ? "ok" : "locked"))
      .catch(() => setState("locked"));
  }, []);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/unlock", { method: "POST", body: JSON.stringify({ token }) });
      setState("ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return <p className="text-zinc-500">检查管理身份…</p>;
  if (state === "ok") return <>{children}</>;
  return (
    <div className="mx-auto max-w-md space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <h2 className="text-lg font-semibold">解锁管理面</h2>
      <p className="text-sm text-zinc-400">
        开发环境下本机 <code className="text-zinc-300">localhost</code> 访问会自动解锁；生产环境请输入{" "}
        <code className="text-zinc-300">.env</code> 里的 <code className="text-zinc-300">ADMIN_TOKEN</code> 或{" "}
        <code className="text-zinc-300">SECRET_MASTER_KEY</code>。
      </p>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="管理口令"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        onClick={() => void unlock()}
        disabled={busy || !token.trim()}
        className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
      >
        {busy ? "验证中…" : "解锁"}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<"database" | "providers" | "bindings" | "usage">("database");
  return (
    <AdminGate>
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">设置</h1>
        <div className="mt-4 flex gap-2">
          {(
            [
              ["database", "数据库"],
              ["providers", "AI 接入"],
              ["bindings", "模型绑定"],
              ["usage", "用量统计"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-lg px-4 py-2 text-sm transition ${
                tab === k ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "database" && <DatabaseTab />}
      {tab === "providers" && <ProvidersTab />}
      {tab === "bindings" && <BindingsTab />}
      {tab === "usage" && <UsageTab />}
    </div>
    </AdminGate>
  );
}

interface DatabaseView {
  configured: boolean;
  source: "file" | "env" | "none";
  urlMasked: string | null;
  ok?: boolean;
  hasSchema?: boolean;
  error?: string;
}

function DatabaseTab() {
  const [info, setInfo] = useState<DatabaseView | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const data = await api<DatabaseView>("/api/settings/database");
    setInfo(data);
  }, []);
  useEffect(() => {
    void Promise.resolve()
      .then(() => load())
      .catch((err) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }));
  }, [load]);

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ ok: boolean; hasSchema: boolean }>("/api/settings/database", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      setMsg({
        ok: true,
        text: res.hasSchema ? "连接成功，已检测到剧本表。" : "连接成功，但还没有表结构。保存后请在项目目录执行 npm run db:deploy。",
      });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ ok: boolean; hasSchema: boolean; urlMasked: string }>("/api/settings/database", {
        method: "PUT",
        body: JSON.stringify({ url }),
      });
      setUrl("");
      await load();
      setMsg({
        ok: true,
        text: res.hasSchema
          ? "已保存并切换到该数据库。"
          : "已保存并切换。库是空的，请在项目目录执行 npm run db:deploy 建表。",
      });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = info?.source === "file" ? "管理后台（local.app.json）" : info?.source === "env" ? ".env / DATABASE_URL" : "未配置";

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h3 className="font-semibold">当前连接</h3>
        {!info && <p className="mt-2 text-sm text-zinc-500">加载中…</p>}
        {info && (
          <div className="mt-3 space-y-1 text-sm">
            <p>
              状态：
              {info.configured ? (
                info.ok ? (
                  <span className="text-emerald-400">已连通</span>
                ) : (
                  <span className="text-red-400">连不上</span>
                )
              ) : (
                <span className="text-zinc-400">未配置</span>
              )}
              {info.hasSchema === false && info.ok && <span className="ml-2 text-amber-400">缺表结构</span>}
            </p>
            <p className="text-zinc-500">来源：{sourceLabel}</p>
            {info.urlMasked && <p className="font-mono text-xs text-zinc-400 break-all">{info.urlMasked}</p>}
            {info.error && <p className="text-red-400">{info.error}</p>}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h3 className="font-semibold">填写 PostgreSQL 连接串</h3>
        <p className="mt-1 text-sm text-zinc-500">
          支持本机或远端。云厂商库通常要加 <code className="text-zinc-300">sslmode=require</code>。保存后写入项目根目录{" "}
          <code className="text-zinc-300">local.app.json</code>（已 gitignore），并立即切换，无需改 .env。
        </p>
        <label className="mt-4 block text-sm text-zinc-400">
          DATABASE_URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="password"
            autoComplete="off"
            placeholder="postgresql://USER:PASSWORD@HOST:5432/jubensha?schema=public&sslmode=require"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500"
          />
        </label>
        {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>}
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => void save()}
            disabled={busy || !url.trim()}
            className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
          >
            {busy ? "处理中…" : "测试并保存"}
          </button>
          <button
            onClick={() => void test()}
            disabled={busy || !url.trim()}
            className="rounded-lg border border-zinc-700 px-5 py-2 text-sm hover:border-zinc-500 disabled:opacity-40"
          >
            只测试、不保存
          </button>
        </div>
      </div>
    </div>
  );
}

const emptyProviderForm = { name: "", protocol: "openai_compatible", baseUrl: "", apiKey: "", note: "" };

function ProvidersTab() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [form, setForm] = useState(emptyProviderForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preset, setPreset] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setProviders(await api<ProviderView[]>("/api/providers"));
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  const applyPreset = (key: string) => {
    setPreset(key);
    const p = PROVIDER_PRESETS.find((x) => x.key === key);
    if (p) setForm((f) => ({ ...f, name: p.label, protocol: p.protocol, baseUrl: p.baseUrl, note: p.note ?? "" }));
  };

  const resetForm = () => {
    setEditingId(null);
    setPreset("");
    setForm(emptyProviderForm);
  };

  const startEdit = (p: ProviderView) => {
    setEditingId(p.id);
    setPreset("");
    setForm({ name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, apiKey: "", note: p.note ?? "" });
    setMsg({ ok: true, text: `正在编辑「${p.name}」。API Key 留空表示不改。` });
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (editingId) {
        const body: Record<string, unknown> = {
          name: form.name,
          protocol: form.protocol,
          baseUrl: form.baseUrl,
          note: form.note || null,
        };
        if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
        await api(`/api/providers/${editingId}`, { method: "PATCH", body: JSON.stringify(body) });
        setMsg({ ok: true, text: "已更新。建议再点一次「测试」。" });
      } else {
        await api("/api/providers", { method: "POST", body: JSON.stringify(form) });
        setMsg({ ok: true, text: "已保存。建议点击「测试」验证连通性。" });
      }
      resetForm();
      await load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const test = async (providerId?: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const useSaved = Boolean(providerId || (editingId && !form.apiKey.trim()));
      const body = useSaved
        ? { providerId: providerId ?? editingId }
        : { protocol: form.protocol, baseUrl: form.baseUrl, apiKey: form.apiKey };
      const res = await api<{ ok: boolean; models: string[] }>("/api/providers/test", { method: "POST", body: JSON.stringify(body) });
      setMsg({ ok: true, text: `连接成功，可用模型 ${res.models.length} 个：${res.models.slice(0, 6).join("、")}${res.models.length > 6 ? " …" : ""}` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p: ProviderView) => {
    await api(`/api/providers/${p.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !p.enabled }) });
    await load();
  };
  const remove = async (p: ProviderView) => {
    if (!confirm(`删除 Provider「${p.name}」？其模型绑定也会一并删除。`)) return;
    await api(`/api/providers/${p.id}`, { method: "DELETE" });
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {providers.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-500">{p.protocol === "anthropic" ? "Anthropic" : "OpenAI 兼容"}</span>
                {!p.enabled && <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-400">已禁用</span>}
              </div>
              <p className="mt-1 font-mono text-xs text-zinc-500">
                {p.baseUrl} · {p.apiKeyMasked}
              </p>
            </div>
            <div className="flex gap-2 text-sm">
              <button onClick={() => startEdit(p)} className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:border-zinc-500">
                编辑
              </button>
              <button onClick={() => void test(p.id)} className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:border-zinc-500">
                测试
              </button>
              <button onClick={() => toggle(p)} className="rounded-lg border border-zinc-700 px-3 py-1.5 hover:border-zinc-500">
                {p.enabled ? "禁用" : "启用"}
              </button>
              <button onClick={() => remove(p)} className="rounded-lg px-3 py-1.5 text-zinc-500 hover:text-red-400">
                删除
              </button>
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
            还没有接入任何 AI 服务商。从下方添加一个（DeepSeek / 智谱 / Qwen / OpenAI / Ollama 等）。
          </p>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h3 className="font-semibold">{editingId ? "编辑 Provider" : "添加 Provider"}</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm text-zinc-400">
            快速模板
            <select value={preset} onChange={(e) => applyPreset(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500">
              <option value="">自定义…</option>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-zinc-400">
            名称
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
          </label>
          <label className="text-sm text-zinc-400">
            协议
            <select value={form.protocol} onChange={(e) => setForm((f) => ({ ...f, protocol: e.target.value }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500">
              <option value="openai_compatible">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="text-sm text-zinc-400">
            Base URL
            <input value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.deepseek.com/v1" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500" />
          </label>
          <label className="text-sm text-zinc-400">
            API Key{editingId ? "（留空不改）" : ""}
            <input value={form.apiKey} onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} type="password" placeholder={editingId ? "不修改则留空" : ""} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
          </label>
          <label className="text-sm text-zinc-400">
            备注（可选）
            <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-amber-500" />
          </label>
        </div>
        {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>}
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => void save()}
            disabled={busy || !form.name || !form.baseUrl || (!editingId && !form.apiKey)}
            className="rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
          >
            {editingId ? "保存修改" : "保存"}
          </button>
          <button
            onClick={() => void test()}
            disabled={busy || !form.baseUrl || (!editingId && !form.apiKey)}
            className="rounded-lg border border-zinc-700 px-5 py-2 text-sm hover:border-zinc-500 disabled:opacity-40"
          >
            先测试连通性
          </button>
          {editingId && (
            <button onClick={resetForm} className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300">
              取消编辑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BindingsTab() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [bindings, setBindings] = useState<BindingView[]>([]);
  const [draft, setDraft] = useState<Record<string, { providerId: string; modelId: string }>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setProviders(await api<ProviderView[]>("/api/providers"));
    const b = await api<BindingView[]>("/api/bindings");
    setBindings(b);
    const d: Record<string, { providerId: string; modelId: string }> = {};
    for (const slot of BINDING_SLOTS) {
      const found = b.find((x) => x.slot === slot.key);
      d[slot.key] = { providerId: found?.providerId ?? "", modelId: found?.modelId ?? "" };
    }
    setDraft(d);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);

  const save = async (slot: string) => {
    const d = draft[slot];
    if (!d?.providerId || !d.modelId) return;
    try {
      await api("/api/bindings", { method: "PUT", body: JSON.stringify({ slot, providerId: d.providerId, modelId: d.modelId }) });
      setMsg(`已保存「${PURPOSE_LABEL[slot]}」绑定。`);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const enabled = providers.filter((p) => p.enabled);

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">
        为不同用途绑定不同模型：DM 与凶手建议用最强模型，路人 AI 用便宜模型即可。模型名参考各服务商文档（例如 deepseek-chat、glm-4.7-air）。
      </p>
      {BINDING_SLOTS.map((slot) => {
        const bound = bindings.find((b) => b.slot === slot.key);
        const d = draft[slot.key] ?? { providerId: "", modelId: "" };
        const preset = PROVIDER_PRESETS.find((p) => p.label === bound?.providerName);
        return (
          <div key={slot.key} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="font-medium">
                  {slot.label}
                  {bound && (
                    <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${bound.providerEnabled ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                      {bound.providerName} / {bound.modelId}
                    </span>
                  )}
                </h4>
                <p className="mt-0.5 text-xs text-zinc-500">{slot.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={d.providerId}
                  onChange={(e) => setDraft((s) => ({ ...s, [slot.key]: { ...d, providerId: e.target.value } }))}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-500"
                >
                  <option value="">选择 Provider…</option>
                  {enabled.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  value={d.modelId}
                  onChange={(e) => setDraft((s) => ({ ...s, [slot.key]: { ...d, modelId: e.target.value } }))}
                  list={`models-${slot.key}`}
                  placeholder="模型名"
                  className="w-44 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm outline-none focus:border-amber-500"
                />
                <datalist id={`models-${slot.key}`}>
                  {(preset?.commonModels ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button onClick={() => save(slot.key)} disabled={!d.providerId || !d.modelId} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-40">
                  保存
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {msg && <p className="text-sm text-emerald-400">{msg}</p>}
    </div>
  );
}

function UsageTab() {
  const [usage, setUsage] = useState<UsageView | null>(null);
  useEffect(() => {
    void api<UsageView>("/api/usage").then(setUsage);
  }, []);
  if (!usage) return <p className="text-zinc-500">加载中…</p>;
  const okRows = usage.summary.filter((r) => r.ok);
  const failRows = usage.summary.filter((r) => !r.ok);
  const total = okRows.reduce((a, r) => a + r.totalTokens, 0);
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <h3 className="font-semibold">近 30 天总用量</h3>
        <p className="mt-2 text-3xl font-bold text-amber-400">{total.toLocaleString()}</p>
        <p className="text-xs text-zinc-500">tokens（按 provider/模型/用途分项如下）</p>
        {okRows.length > 0 && (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1">Provider</th>
                <th>模型</th>
                <th>用途</th>
                <th className="text-right">调用</th>
                <th className="text-right">输入</th>
                <th className="text-right">输出</th>
              </tr>
            </thead>
            <tbody>
              {okRows.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  <td className="py-1.5">{r.providerName}</td>
                  <td className="font-mono text-xs">{r.modelId}</td>
                  <td>{PURPOSE_LABEL[r.purpose] ?? r.purpose}</td>
                  <td className="text-right">{r.calls}</td>
                  <td className="text-right">{r.promptTokens.toLocaleString()}</td>
                  <td className="text-right">{r.completionTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {okRows.length === 0 && <p className="mt-3 text-sm text-zinc-500">还没有任何调用记录。</p>}
      </div>
      {failRows.length > 0 && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-sm">
          <h3 className="font-semibold text-red-400">失败调用</h3>
          <ul className="mt-2 space-y-1 text-zinc-400">
            {failRows.map((r, i) => (
              <li key={i}>
                {r.providerName}/{r.modelId} · {PURPOSE_LABEL[r.purpose] ?? r.purpose} · {r.calls} 次
              </li>
            ))}
          </ul>
          <ul className="mt-3 space-y-1 text-xs text-zinc-500">
            {usage.recentErrors.slice(0, 5).map((e, i) => (
              <li key={i} className="truncate">
                {new Date(e.createdAt).toLocaleString()} {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
