"use client";

import { useState } from "react";
import { NarrativeBlocks, TimelineList } from "@/components/ScriptContent";
import { PHASE_LABEL, type GameEventView, type GameSummary } from "@/lib/client";
import type { ClueV2 } from "@/core/script/v2/schema";
import type { DmView } from "./useGameStream";

type SeatView = GameSummary["seats"][number];

interface ClueCard {
  id: string;
  name: string;
  content: string;
  private: boolean;
  structured: ClueV2 | null;
}

/**
 * ★ 右栏个人信息面板（批次 I3 自 play/[gameId]/page.tsx 拆出）★：
 * 我的剧本 / 我的线索（含当场公开-私藏决策与转交）/ 时间线三页签；
 * DM 视角下同一组页签换成「真相 / 全部线索 / 时间线」。
 * 线索持有权从事件流推导：我收到的 clue/transfer − 我最近一次转出的。
 */
export function InfoRail({
  summary,
  events,
  me,
  mySeat,
  isDm,
  dmData,
  ended,
  activeSeats,
  sending,
  send,
}: {
  summary: GameSummary;
  events: GameEventView[];
  me: SeatView | null;
  mySeat: number | null;
  isDm: boolean;
  dmData: DmView | null;
  ended: boolean;
  activeSeats: SeatView[];
  sending: boolean;
  send: (action: Record<string, unknown>) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<"script" | "clues" | "timeline">("script");
  const [decidedClues, setDecidedClues] = useState<Set<string>>(new Set());
  const [transferClueId, setTransferClueId] = useState<string | null>(null);
  const phase = summary.phase;

  // 我的线索卡（持有权 = 我发现的 + 转给我的 − 最近一次转出的）
  const lastTransferByClue = new Map<string, GameEventView>();
  for (const e of events) {
    if (e.type === "transfer" && e.content.clueId) lastTransferByClue.set(e.content.clueId, e);
  }
  const clueCardOf = (id: string, name: string, content: string, isPrivate: boolean): ClueCard => ({
    id,
    name,
    content,
    private: isPrivate,
    structured: summary.myCluesV2.find((clue) => clue.id === id) ?? null,
  });
  const myClueMap = new Map<string, ClueCard>();
  for (const e of events) {
    if (e.type === "clue" && e.visibility === `seat:${mySeat}` && e.content.clueId) {
      myClueMap.set(e.content.clueId, clueCardOf(e.content.clueId, e.content.clueName ?? "", e.content.clueContent ?? "", e.content.private === true));
    }
    if (e.type === "transfer" && e.toSeat === mySeat && e.content.clueId) {
      myClueMap.set(e.content.clueId, clueCardOf(e.content.clueId, e.content.clueName ?? "", e.content.clueContent ?? "", true));
    }
  }
  for (const [id, ev] of lastTransferByClue) {
    if (ev.toSeat !== mySeat) myClueMap.delete(id);
  }
  const myClueCardsUnique = [...myClueMap.values()];

  return (
    <aside className="game-panel overflow-hidden">
      <div role="tablist" aria-label="个人信息面板" className="flex border-b border-gold-400/10 text-sm">
        {(
          [
            ["script", isDm ? "真相" : me?.myCard ? "我的剧本" : "剧本"],
            ["clues", isDm ? "全部线索" : `我的线索${myClueCardsUnique.length ? ` (${myClueCardsUnique.length})` : ""}`],
            ["timeline", "时间线"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`relative flex-1 px-2 py-3 text-center transition ${tab === k ? "bg-gold-400/7 text-gold-400 after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-gold-400" : "text-paper-500 hover:text-paper-200"}`}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="max-h-[65vh] overflow-y-auto p-4 text-sm">
        {tab === "script" && isDm && (
          dmData ? (
            dmData.structured ? (
              <div className="space-y-4 leading-relaxed text-xs">
                <section className="rounded-lg border border-danger-400/30 bg-danger-400/5 p-3">
                  <h4 className="font-semibold text-danger-400">真相</h4>
                  <p className="mt-1 text-paper-200">真凶：{dmData.structured.characters.find((c) => c.privateCard.isCulprit)?.name}</p>
                  <h5 className="mt-2 font-medium text-paper-300">作案手法</h5>
                  <NarrativeBlocks blocks={dmData.structured.truth.method.summary} className="mt-1 text-paper-400" />
                  <h5 className="mt-3 font-medium text-paper-300">完整时间线</h5>
                  <TimelineList entries={dmData.structured.truth.timeline} className="mt-2" />
                </section>
                <section>
                  <h4 className="font-semibold text-paper-400">各角色秘密</h4>
                  {dmData.structured.characters.map((c) => (
                    <div key={c.id} className="mt-2 rounded-lg border border-secret-400/15 bg-secret-400/3 p-2.5">
                      <p className="font-medium text-paper-200">{c.name}{c.privateCard.isCulprit && <span className="ml-1.5 text-danger-400">← 真凶</span>}{c.seatIndex !== null && <span className="ml-1.5 text-paper-500">（座位 {c.seatIndex + 1}）</span>}</p>
                      {c.privateCard.secrets.map((secret) => <div key={secret.id} className="mt-1"><p className="font-medium text-paper-400">{secret.title}</p><NarrativeBlocks blocks={secret.content} className="mt-1 text-paper-400" /></div>)}
                      {c.privateCard.objectives.map((objective) => <div key={objective.id} className="mt-1"><p className="font-medium text-paper-500">{objective.title}</p><NarrativeBlocks blocks={objective.content} className="mt-1 text-paper-500" /></div>)}
                    </div>
                  ))}
                </section>
              </div>
            ) : (
              <div className="space-y-3 leading-relaxed text-xs">
                <section className="rounded-lg border border-danger-400/30 bg-danger-400/5 p-3">
                  <h4 className="font-semibold text-danger-400">真相</h4>
                  <p className="mt-1 text-paper-200">真凶：{dmData.characters.find((c) => c.isCulprit)?.name} · {dmData.truth.method}</p>
                  <p className="mt-2 whitespace-pre-wrap text-paper-400">{dmData.truth.fullTimeline}</p>
                  <p className="mt-2 text-paper-500">关键证据：{dmData.truth.keyEvidence.join("、")}</p>
                </section>
                <section>
                  <h4 className="font-semibold text-paper-400">各角色秘密</h4>
                  {dmData.characters.map((c) => (
                    <div key={c.id} className="mt-2 rounded-lg border border-secret-400/15 bg-secret-400/3 p-2.5">
                      <p className="font-medium text-paper-200">{c.name}{c.isCulprit && <span className="ml-1.5 text-danger-400">← 真凶</span>}{c.seatIndex !== null && <span className="ml-1.5 text-paper-500">（座位 {c.seatIndex + 1}）</span>}</p>
                      <p className="mt-1 text-paper-400">秘密：{c.secret}</p>
                      <p className="mt-0.5 text-paper-500">目标：{c.goal}</p>
                    </div>
                  ))}
                </section>
              </div>
            )
          ) : (
            <p className="text-paper-500">加载真相…</p>
          )
        )}
        {tab === "script" && !isDm && (
          me?.myCard ? (
            me.myCardV2 ? (
              <div className="space-y-4 leading-relaxed">
                <section><h4 className="text-xs font-semibold text-paper-400">背景</h4><NarrativeBlocks blocks={me.myCardV2.backstory} className="mt-1 text-paper-300" /></section>
                <section><h4 className="text-xs font-semibold text-danger-400">你的秘密（绝不主动透露）</h4>{me.myCardV2.secrets.map((secret) => <div key={secret.id} className="mt-1 rounded-lg border border-danger-400/15 bg-danger-400/5 p-2 text-paper-300"><p className="font-medium text-danger-300">{secret.title}</p><NarrativeBlocks blocks={secret.content} className="mt-1" /></div>)}</section>
                <section><h4 className="text-xs font-semibold text-paper-400">目标</h4>{me.myCardV2.objectives.map((objective) => <div key={objective.id} className="mt-1"><p className="font-medium text-paper-200">{objective.title}</p><NarrativeBlocks blocks={objective.content} className="mt-1 text-paper-300" /></div>)}</section>
                <section><h4 className="text-xs font-semibold text-paper-400">你的时间线</h4><TimelineList entries={me.myCardV2.timeline} locations={new Map(summary.scriptV2?.locations.map((location) => [location.id, location.name]))} className="mt-2 text-paper-300" /></section>
                {me.myCardV2.knowledge.length > 0 && <section><h4 className="text-xs font-semibold text-paper-400">你额外知道</h4><div className="mt-1 space-y-2">{me.myCardV2.knowledge.map((item) => <div key={item.id} className="rounded-lg border border-gold-400/10 p-2"><p className="font-medium text-paper-200">{item.title}</p><NarrativeBlocks blocks={item.content} className="mt-1 text-paper-300" /></div>)}</div></section>}
              </div>
            ) : (
            <div className="space-y-3 leading-relaxed">
              <section>
                <h4 className="text-xs font-semibold text-paper-400">背景</h4>
                <p className="mt-1 text-paper-300">{me.myCard.backstory}</p>
              </section>
              <section>
                <h4 className="text-xs font-semibold text-danger-400">你的秘密（绝不主动透露）</h4>
                <p className="mt-1 text-paper-300">{me.myCard.secret}</p>
              </section>
              <section>
                <h4 className="text-xs font-semibold text-paper-400">目标</h4>
                <p className="mt-1 text-paper-300">{me.myCard.goal}</p>
              </section>
              <section>
                <h4 className="text-xs font-semibold text-paper-400">你的时间线</h4>
                <p className="mt-1 text-paper-300">{me.myCard.timeline}</p>
              </section>
              {me.myCard.knowledge.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-paper-400">你额外知道</h4>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-paper-300">
                    {me.myCard.knowledge.map((k, i) => (
                      <li key={i}>{k}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
            )
          ) : (
            <p className="whitespace-pre-wrap leading-relaxed text-paper-400">{summary.background}</p>
          )
        )}
        {tab === "clues" && isDm && (
          <div className="space-y-2 text-xs">
            {dmData ? (
              dmData.structured ? dmData.structured.clues.map((c) => {
                const isPublic = events.some((e) => e.type === "clue" && e.visibility === "public" && e.content.clueId === c.id);
                const isHeld = events.some((e) => e.type === "clue" && e.visibility !== "public" && e.content.clueId === c.id);
                const location = dmData.structured?.clues.find((item) => item.id === c.id)?.locationId;
                const locationName = dmData.structured ? summary.scriptV2?.locations.find((item) => item.id === location)?.name ?? location : location;
                return (
                  <div key={c.id} className="clue-card p-3">
                    <p className="font-medium text-paper-200">{c.name}<span className="ml-2 text-paper-500">[{locationName}]</span><span className={`ml-2 ${isPublic ? "text-clue-400" : isHeld ? "text-secret-400" : "text-paper-500"}`}>{isPublic ? "已公开" : isHeld ? "被持有" : "未发现"}</span></p>
                    <NarrativeBlocks blocks={c.content} className="mt-1 text-paper-400" />
                  </div>
                );
              }) : dmData.clues.map((c) => {
                const isPublic = events.some((e) => e.type === "clue" && e.visibility === "public" && e.content.clueId === c.id);
                const isHeld = events.some((e) => e.type === "clue" && e.visibility !== "public" && e.content.clueId === c.id);
                return (
                  <div key={c.id} className="clue-card p-3">
                    <p className="font-medium text-paper-200">
                      {c.name}
                      <span className="ml-2 text-paper-500">[{c.location}]</span>
                      <span className={`ml-2 ${isPublic ? "text-clue-400" : isHeld ? "text-secret-400" : "text-paper-500"}`}>
                        {isPublic ? "已公开" : isHeld ? "被持有" : "未发现"}
                      </span>
                    </p>
                    <p className="mt-1 text-paper-400">{c.content}</p>
                  </div>
                );
              })
            ) : (
              <p className="text-paper-500">加载中…</p>
            )}
          </div>
        )}
        {tab === "clues" && !isDm && (
          <div className="space-y-3">
            {myClueCardsUnique.length === 0 && <p className="text-paper-500">还没有获得任何线索。搜证阶段选择地点后在这里查看。</p>}
            {myClueCardsUnique.map((c) => {
              const isPublic = events.some((e) => e.type === "clue" && e.visibility === "public" && e.content.clueId === c.id);
              const needDecision = phase === "SEARCH" && c.private && !isPublic && !decidedClues.has(c.id);
              const canTransfer = Boolean(summary.flow?.allowClueTransfer) && phase === "DISCUSSION" && !isPublic && !ended;
              return (
                <div key={c.id} className="clue-card evidence-reveal p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-clue-400">{c.name}</span>
                    <span className="rounded-full border border-clue-400/20 px-2 py-0.5 text-[10px] text-clue-400">{isPublic ? "已公开" : "私藏证据"}</span>
                  </div>
                  {c.structured ? <NarrativeBlocks blocks={c.structured.content} className="mt-2 leading-relaxed text-paper-300" /> : <p className="mt-2 leading-relaxed text-paper-300">{c.content}</p>}
                  {needDecision && (
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => {
                          setDecidedClues((s) => new Set(s).add(c.id));
                          void send({ type: "publish", clueId: c.id, publish: true });
                        }}
                        className="rounded-lg bg-clue-400 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:brightness-110"
                      >
                        当场公开
                      </button>
                      <button
                        onClick={() => {
                          setDecidedClues((s) => new Set(s).add(c.id));
                          void send({ type: "publish", clueId: c.id, publish: false });
                        }}
                        className="rounded-lg border border-secret-400/30 px-3 py-1.5 text-xs text-secret-400 hover:border-secret-400/60"
                      >
                        {(summary.guaranteedDeadlines?.[c.id] ?? Infinity) <= summary.round ? "暂时私藏，本轮结束由主持公开" : "私藏"}
                      </button>
                    </div>
                  )}
                  {canTransfer && !needDecision && (
                    <div className="mt-2 space-y-1.5">
                      {transferClueId === c.id ? (
                        <>
                          <p className="text-xs text-paper-500">悄悄转交给谁（仅双方可见）：</p>
                          <div className="flex flex-wrap gap-1.5">
                            {activeSeats
                              .filter((s) => s.index !== mySeat)
                              .map((s) => (
                                <button
                                  key={s.index}
                                  onClick={() => {
                                    setTransferClueId(null);
                                    void send({ type: "transfer", clueId: c.id, toSeat: s.index });
                                  }}
                                  disabled={sending}
                                  className="rounded-lg border border-secret-400/40 px-2.5 py-1 text-xs text-secret-400 hover:bg-secret-400/10 disabled:opacity-40"
                                >
                                  {s.characterName}
                                </button>
                              ))}
                            <button onClick={() => setTransferClueId(null)} className="rounded-lg border border-paper-500/30 px-2.5 py-1 text-xs text-paper-400 hover:text-paper-200">
                              取消
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          onClick={() => setTransferClueId(c.id)}
                          disabled={sending}
                          className="rounded-lg border border-secret-400/30 px-3 py-1.5 text-xs text-secret-400 hover:border-secret-400/60 disabled:opacity-40"
                        >
                          转交这张线索
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {tab === "timeline" && (
          <ul className="space-y-2 text-xs text-paper-400">
            {events
              .filter((e) => e.type === "phase" || e.type === "system" || e.type === "reveal")
              .map((e) => (
                <li key={e.seq}>
                  <span className="text-paper-500">{new Date(e.createdAt).toLocaleTimeString()}</span>{" "}
                  {e.type === "phase" ? `进入 ${PHASE_LABEL[(e.content.phase as string) ?? e.phase] ?? e.phase}` : e.content.text}
                </li>
              ))}
            {events.filter((e) => e.type === "phase" || e.type === "system" || e.type === "reveal").length === 0 && (
              <li>还没有事件。</li>
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}
