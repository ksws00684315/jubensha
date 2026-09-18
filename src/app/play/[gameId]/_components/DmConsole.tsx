"use client";

import { useState } from "react";
import type { DmView } from "./useGameStream";

export type DmAction = { type: "narrate" | "nudge" | "skip_turn" | "handout" | "hint"; text?: string; clueId?: string; hintIndex?: number };

/**
 * ★ 真人 DM 控制台（批次 I3 自 play/[gameId]/page.tsx 拆出）★：
 * 真相速览 + 旁白 / 材料补发 / 分级提示 / 催促与跳过回合。
 * 指令下发与错误回显由页面注入（sendDm 带 dmToken 鉴权）。
 */
export function DmConsole({
  dmData,
  error,
  onSend,
}: {
  dmData: DmView | null;
  error: string | null;
  onSend: (action: DmAction) => void;
}) {
  const [dmText, setDmText] = useState("");
  const [dmClueId, setDmClueId] = useState("");
  const [dmHintIndex, setDmHintIndex] = useState("");

  const narrate = () => {
    if (!dmText.trim()) return;
    onSend({ type: "narrate", text: dmText });
    setDmText("");
  };

  return (
    <div className="game-panel space-y-3 border-secret-400/40 bg-secret-400/5 p-4">
      <h3 className="text-sm font-medium text-secret-400">DM 控制台</h3>
      {error && <p className="text-xs text-danger-400">{error}</p>}
      {dmData && (
        <div className="rounded-lg bg-ink-950/70 p-3 text-xs text-paper-400">
          <p>
            真凶：<span className="font-semibold text-danger-400">{dmData.structured?.characters.find((c) => c.privateCard.isCulprit)?.name ?? dmData.characters.find((c) => c.isCulprit)?.name}</span>
          </p>
          <p className="mt-1">{dmData.structured ? "结构化真相已加载，可在右侧查看完整时间线。" : `${dmData.truth.method.slice(0, 60)}…（完整真相见右侧「真相」页）`}</p>
        </div>
      )}
      <div className="flex gap-2">
        <input
          aria-label="DM 叙述内容"
          value={dmText}
          onChange={(e) => setDmText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") narrate();
          }}
          placeholder="以 DM 身份向全场旁白…"
          className="min-w-0 flex-1 rounded-lg border border-secret-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-secret-400"
        />
        <button
          onClick={narrate}
          disabled={!dmText.trim()}
          className="rounded-lg bg-secret-400 px-3 text-sm font-medium text-ink-950 hover:brightness-110 disabled:opacity-40"
        >
          旁白
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex gap-2">
          <select aria-label="选择要补发的材料" value={dmClueId} onChange={(e) => setDmClueId(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-clue-400/20 bg-ink-950 px-2 py-2 text-xs text-paper-200">
            <option value="">选择材料后公开…</option>
            {dmData?.clues.map((clue) => <option key={clue.id} value={clue.id}>{clue.name}</option>)}
          </select>
          <button disabled={!dmClueId} onClick={() => { onSend({ type: "handout", clueId: dmClueId }); setDmClueId(""); }} className="rounded-lg border border-clue-400/30 px-2 text-xs text-clue-300 disabled:opacity-40">补发</button>
        </div>
        <div className="flex gap-2">
          <select aria-label="选择分级提示" value={dmHintIndex} onChange={(e) => setDmHintIndex(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-gold-400/20 bg-ink-950 px-2 py-2 text-xs text-paper-200">
            <option value="">选择分级提示…</option>
            {dmData?.hostGuide?.stallBreakers.map((item, index) => <option key={index} value={index}>{item.condition}</option>)}
          </select>
          <button disabled={dmHintIndex === ""} onClick={() => { onSend({ type: "hint", hintIndex: Number(dmHintIndex) }); setDmHintIndex(""); }} className="rounded-lg border border-gold-400/30 px-2 text-xs text-gold-300 disabled:opacity-40">提示</button>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSend({ type: "nudge" })} className="flex-1 rounded-lg border border-secret-400/20 px-3 py-1.5 text-xs text-paper-300 hover:border-secret-400/60">
          催促推进
        </button>
        <button onClick={() => onSend({ type: "skip_turn" })} className="flex-1 rounded-lg border border-secret-400/20 px-3 py-1.5 text-xs text-paper-300 hover:border-secret-400/60">
          跳过当前回合
        </button>
      </div>
    </div>
  );
}
