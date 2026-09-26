"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BrandMark, SoundIcon } from "@/components/VisualIcons";
import { NarrativeBlocks } from "@/components/ScriptContent";
import { PHASE_LABEL, type GameEventView, type GameSummary } from "@/lib/client";
import { applyPendingWhisperResult, createPendingWhisper, editPendingWhisper, isPendingWhisperDue, retryPendingWhisper, type PendingWhisper } from "@/lib/pending-whisper";

/**
 * ★ 中栏现场记录（批次 I3 自 play/[gameId]/page.tsx 拆出）★：
 * 事件气泡流 + 流式 delta/思考态 + DM 旁白气泡 + 悄悄话回复 + 真相复盘 +
 * 贴底自动滚动（上滑时浮出「回到底部」）+ 发言输入区。
 */
export interface ChatFeedProps {
  summary: GameSummary;
  events: GameEventView[];
  mySeat: number | null;
  seatName: (i: number) => string;
  aiSeatSet: Set<number>;
  ended: boolean;
  reveal: GameEventView | undefined;
  deltas: Record<number, string>;
  dmThinking: boolean;
  dmDelta: string;
  /** 输入区是否显示（本席 + 自我介绍/讨论阶段 + 未终局） */
  showComposer: boolean;
  canSpeak: boolean;
  answering: boolean;
  mySpeakTurn: boolean;
  speakPlaceholder: string;
  sending: boolean;
  error: string | null;
  input: string;
  onInput: (value: string) => void;
  onSubmitSpeak: () => void;
  onSpeakEvent: (eventSeq: string) => void;
  onSendWhisper: (toSeat: number, text: string) => Promise<boolean>;
}

export function ChatFeed(props: ChatFeedProps) {
  const {
    summary,
    events,
    mySeat,
    seatName,
    aiSeatSet,
    ended,
    reveal,
    deltas,
    dmThinking,
    dmDelta,
    showComposer,
    canSpeak,
    answering,
    mySpeakTurn,
    speakPlaceholder,
    sending,
    error,
    input,
    onInput,
    onSubmitSpeak,
    onSpeakEvent,
    onSendWhisper,
  } = props;

  const chatRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [whisperText, setWhisperText] = useState<Record<number, string>>({});
  const [pendingWhispers, setPendingWhispers] = useState<Record<number, PendingWhisper>>({});
  const foundClueIds = new Set(events.filter((ev) => ev.type === "clue" && ev.visibility === `seat:${mySeat}`).map((ev) => ev.content.clueId).filter((id): id is string => typeof id === "string"));
  const displayedEvents = events.filter((ev) => !(ev.type === "clue" && ev.visibility === "public" && typeof ev.content.clueId === "string" && foundClueIds.has(ev.content.clueId)));

  // 自动滚动：仅在用户贴底时跟随；上滑阅读历史时不打断
  useEffect(() => {
    if (atBottomRef.current) {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [events, deltas]);
  const onChatScroll = useCallback(() => {
    const el = chatRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 80;
    atBottomRef.current = atBottom;
    setShowJumpToBottom(!atBottom);
  }, []);
  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setShowJumpToBottom(false);
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  // ★ AI 主动私信的回复 ★：仅当对方窗口开着且这是最新一条往来消息时显示回复框
  const openWhispers = summary.openWhispers ?? [];
  const isLatestWhisper = (ev: GameEventView): boolean => {
    if (ev.type !== "private" || ev.toSeat !== mySeat || ev.fromSeat === null) return false;
    if (!openWhispers.includes(ev.fromSeat)) return false;
    const last = events.findLast(
      (e) => e.type === "private" && ((e.fromSeat === ev.fromSeat && e.toSeat === mySeat) || (e.fromSeat === mySeat && e.toSeat === ev.fromSeat))
    );
    return last?.seq === ev.seq;
  };
  const replyWhisper = (toSeat: number) => {
    const text = (whisperText[toSeat] ?? "").trim();
    if (!text || pendingWhispers[toSeat]) return;
    setPendingWhispers((current) => ({ ...current, [toSeat]: createPendingWhisper(text, Date.now()) }));
    setWhisperText((w) => {
      const next = { ...w };
      delete next[toSeat];
      return next;
    });
  };

  const flushWhisper = useCallback(async (toSeat: number, dueAt: number) => {
    const pending = pendingWhispers[toSeat];
    if (!pending || pending.dueAt !== dueAt || !isPendingWhisperDue(pending, Date.now())) return;
    setPendingWhispers((current) => ({ ...current, [toSeat]: { ...current[toSeat], sending: true } }));
    const ok = await onSendWhisper(toSeat, pending.text);
    setPendingWhispers((current) => {
      const next = { ...current };
      const result = applyPendingWhisperResult(pending, ok);
      if (result) next[toSeat] = result;
      else delete next[toSeat];
      return next;
    });
  }, [onSendWhisper, pendingWhispers]);

  useEffect(() => {
    const entry = Object.entries(pendingWhispers).find(([, value]) => !value.sending && !value.failed);
    if (!entry) return;
    const [seat, pending] = entry;
    const timer = setTimeout(() => void flushWhisper(Number(seat), pending.dueAt), Math.max(0, pending.dueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pendingWhispers, flushWhisper]);

  return (
    <section className="game-panel relative flex h-[min(78vh,900px)] min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-gold-400/10 px-5 py-3">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.18em] text-paper-500">LIVE SCENE</p>
          <h2 className="text-sm font-medium text-paper-200">现场记录</h2>
        </div>
        {dmThinking ? (
          <span className="thinking-dots text-xs font-medium text-gold-400">主持人正在撰写旁白</span>
        ) : (
          <span className="flex items-center gap-2 text-[10px] font-semibold tracking-widest text-success-400">
            <span className="size-1.5 rounded-full bg-success-400 shadow-[0_0_8px_rgba(102,196,154,.75)]" /> LIVE
          </span>
        )}
      </div>
      <div
        ref={chatRef}
        onScroll={onChatScroll}
        role="log"
        aria-live="polite"
        aria-label="现场记录消息流"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-5"
      >
        <div className="case-briefing p-4 text-sm leading-relaxed text-paper-300">
          <span className="eyebrow">Case Briefing · 案情背景</span>
          {summary.scriptV2 ? (
            <NarrativeBlocks blocks={summary.scriptV2.background} className="mt-2" />
          ) : (
            <p className="mt-2 whitespace-pre-wrap">{summary.background}</p>
          )}
        </div>

        {displayedEvents.map((ev) => (
          <div key={ev.seq}>
            <EventBubble
              ev={ev}
              publicEvidence={summary.publicEvidence ?? []}
              mySeat={mySeat}
              seatName={seatName}
              ttsSeats={aiSeatSet}
              onSpeak={onSpeakEvent}
            />
            {isLatestWhisper(ev) && (
              <div className="mx-auto mt-1 max-w-[85%] space-y-1.5">
                <div className="flex gap-1.5">
                <input
                  aria-label="悄悄话回复"
                  value={pendingWhispers[ev.fromSeat ?? -1]?.text ?? whisperText[ev.fromSeat ?? -1] ?? ""}
                  disabled={pendingWhispers[ev.fromSeat ?? -1]?.sending}
                  onChange={(e) => {
                    const seat = ev.fromSeat ?? -1;
                    if (pendingWhispers[seat]) {
                      setPendingWhispers((current) => ({ ...current, [seat]: editPendingWhisper(current[seat], e.target.value, Date.now()) }));
                    } else {
                      setWhisperText((w) => ({ ...w, [seat]: e.target.value }));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (whisperText[ev.fromSeat ?? -1] ?? "").trim()) replyWhisper(ev.fromSeat ?? -1);
                  }}
                  maxLength={300}
                  placeholder={`悄悄回复 ${seatName(ev.fromSeat ?? 0)}（3 秒后发送，可撤销）…`}
                  className="min-w-0 flex-1 rounded-lg border border-dashed border-secret-400/30 bg-ink-950 px-3 py-1.5 text-xs text-paper-50 outline-none placeholder:text-paper-500 focus:border-secret-400"
                />
                <button
                  onClick={() => replyWhisper(ev.fromSeat ?? -1)}
                  disabled={!(whisperText[ev.fromSeat ?? -1] ?? "").trim() || Boolean(pendingWhispers[ev.fromSeat ?? -1])}
                  className="rounded-lg border border-secret-400/40 px-3 text-xs font-semibold text-secret-400 hover:bg-secret-400/10 disabled:opacity-40"
                >
                  准备发送
                </button>
                </div>
                {pendingWhispers[ev.fromSeat ?? -1] && (
                  <div className="flex items-center justify-between rounded-lg border border-secret-400/20 bg-secret-400/5 px-3 py-2 text-xs text-secret-300">
                    <span>{pendingWhispers[ev.fromSeat ?? -1].sending ? "正在发送…" : pendingWhispers[ev.fromSeat ?? -1].failed ? "发送失败，可修改后重试" : "待发送 · 3 秒内可修改或撤销"}</span>
                    <span className="flex gap-2">
                      {pendingWhispers[ev.fromSeat ?? -1].failed && (
                        <button type="button" onClick={() => setPendingWhispers((current) => ({ ...current, [ev.fromSeat ?? -1]: retryPendingWhisper(current[ev.fromSeat ?? -1], Date.now()) }))} className="underline">重试</button>
                      )}
                      {!pendingWhispers[ev.fromSeat ?? -1].sending && (
                        <button type="button" onClick={() => setPendingWhispers((current) => { const next = { ...current }; delete next[ev.fromSeat ?? -1]; return next; })} className="underline">撤销</button>
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {dmThinking && (
          <div className="fade-up rounded-2xl rounded-tl-sm border border-gold-400/25 bg-gold-400/5 px-4 py-3 text-sm">
            <p className="eyebrow">DM · 主持人</p>
            {dmDelta ? (
              <p className="typing-caret mt-1 whitespace-pre-wrap leading-relaxed text-paper-300">{dmDelta}</p>
            ) : (
              <p className="thinking-dots mt-1 text-paper-400">正在组织旁白，请稍候</p>
            )}
          </div>
        )}

        {/* 流式中的 AI 发言 */}
        {Object.entries(deltas).map(([seatStr, text]) =>
          text ? (
            <div key={`delta-${seatStr}`} className="fade-up flex gap-2">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-secret-400/20 bg-secret-400/5 px-4 py-2.5 text-sm">
                <p className="text-xs text-secret-400">{seatName(Number(seatStr))} · AI 正在演绎</p>
                <p className="typing-caret mt-1 whitespace-pre-wrap leading-relaxed text-paper-200">{text}</p>
              </div>
            </div>
          ) : null
        )}

        {ended && reveal && <RevealBlock summary={summary} reveal={reveal} mySeat={mySeat} />}
      </div>

      {showJumpToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="回到底部并恢复自动跟随"
          className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full border border-gold-400/40 bg-ink-950/90 px-4 py-1.5 text-xs text-gold-400 shadow-lg hover:bg-gold-400/10"
        >
          ↓ 回到底部
        </button>
      )}

      {/* 输入区 */}
      {showComposer && (
        <fieldset className="border-t border-gold-400/10 bg-ink-950/45 p-4">
          <legend className="px-1 text-xs font-semibold text-gold-400">{answering ? "当众回答" : "当众陈述"}</legend>
          {error && <p className="mb-2 text-xs text-danger-400">{error}</p>}
          <p className="mb-2 text-[11px] text-paper-500">这段内容会进入全场记录。需要向特定玩家提问，请使用左侧“公开质询”区域。</p>
          {/* 推荐回复：轮到你发言时后台生成的建议短句，点击直接填入 */}
          {mySpeakTurn && !sending && (summary.suggestions?.length ?? 0) > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold tracking-widest text-paper-500">试试说</span>
              {summary.suggestions.map((s, i) => (
                <button
                  key={`sug-${i}`}
                  onClick={() => onInput(s)}
                  className="rounded-full border border-gold-400/20 bg-gold-400/5 px-2.5 py-1 text-xs text-paper-300 hover:border-gold-400/50 hover:text-paper-100"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              id="public-speech"
              value={input}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && input.trim() && canSpeak) onSubmitSpeak();
              }}
              disabled={!canSpeak || sending}
              placeholder={speakPlaceholder}
              aria-label={answering ? "当众回答内容" : "当众陈述内容"}
              className="min-w-0 flex-1 rounded-lg border border-gold-400/15 bg-ink-950 px-3 py-2.5 text-sm text-paper-50 outline-none placeholder:text-paper-500 focus:border-gold-400 disabled:opacity-50"
            />
            <button
              onClick={() => {
                if (canSpeak) onSubmitSpeak();
              }}
              disabled={!canSpeak || sending || !input.trim()}
              className="rounded-lg bg-gold-500 px-5 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
            >
              {answering ? "回答" : "发言"}
            </button>
          </div>
        </fieldset>
      )}
    </section>
  );
}

/** 真相揭晓 + 复盘答题成绩单（终局幕帘） */
function RevealBlock({ summary, reveal, mySeat }: { summary: GameSummary; reveal: GameEventView; mySeat: number | null }) {
  const finale = reveal.content.finale as { result: "caught" | "escaped"; title: string; content: string; verdict: string } | undefined;
  return (
    <div className="reveal-stage reveal-curtain p-6 text-center text-sm sm:p-8">
      <p className="eyebrow text-danger-400">Final Reveal · 真相揭晓</p>
      <BrandMark className="mx-auto mt-5 size-14 text-danger-400" />
      <h3 className="mt-3 text-2xl font-bold text-paper-50">真凶：{reveal.content.culpritName}</h3>
      <p className="mt-2 font-medium text-danger-400">
        {finale?.verdict ?? (reveal.content.caught
          ? "凶手被指认，好人阵营胜利！"
          : reveal.content.culpritSeat !== undefined && reveal.content.culpritSeat < 0
            ? "真凶未在本局入座，指认无果。"
            : reveal.content.tiedSeats?.length
              ? `投票在${reveal.content.tiedSeats.map((s) => `座位${s + 1}`).join(" 与 ")}之间出现平票，指认失败，凶手逃脱……凶手阵营胜利！`
              : "凶手逃脱了……凶手阵营胜利！")}
      </p>
      <p className="mx-auto mt-4 max-w-2xl whitespace-pre-wrap text-left leading-7 text-paper-300">{reveal.content.reveal}</p>
      {Array.isArray(reveal.content.interactionChoices) && <div className="mt-4 text-left"><h4>角色抉择</h4>{(reveal.content.interactionChoices as Array<{ beatId: string; text: string }>).map((choice) => <p key={choice.beatId}>{choice.text}</p>)}</div>}
      <p className="mt-4 text-xs text-paper-500">{finale ? `${finale.title}：${finale.content}` : reveal.content.winText}</p>
      {summary.settlement && (
        <div className="mx-auto mt-5 max-w-2xl rounded-xl border border-gold-400/20 bg-ink-950/60 p-4 text-left">
          <p className="text-[10px] font-semibold tracking-[0.16em] text-gold-400">RESULT · 本局结算</p>
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-paper-500">阵营结果</p><p className="mt-1 text-paper-200">{summary.settlement.outcome === "caught" ? "成功抓获真凶" : "真凶逃脱"}</p></div>
            <div><p className="text-xs text-paper-500">你的投票</p><p className={summary.settlement.voteCorrect ? "mt-1 text-success-400" : "mt-1 text-danger-400"}>{summary.settlement.voteCorrect ? "正确" : "未命中"}</p></div>
            <div><p className="text-xs text-paper-500">有效证据</p><p className="mt-1 text-paper-200">{summary.settlement.evidenceCount} 条</p></div>
            <div><p className="text-xs text-paper-500">表现分</p><p className="mt-1 text-gold-400">{summary.settlement.score}/100</p></div>
          </div>
        </div>
      )}
      {summary.culpritSettlement && (
        <div className="mx-auto mt-5 max-w-2xl rounded-xl border border-danger-400/30 bg-ink-950/60 p-4 text-left">
          <p className="text-[10px] font-semibold tracking-[0.16em] text-danger-400">RESULT · 凶手结算</p>
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div><p className="text-xs text-paper-500">你的身份</p><p className={`mt-1 font-medium ${summary.culpritSettlement.outcome === "exposed" ? "text-danger-400" : "text-success-400"}`}>{summary.culpritSettlement.outcome === "exposed" ? "已被当场识破" : "全身而退"}</p></div>
            <div><p className="text-xs text-paper-500">指认你的票数</p><p className="mt-1 text-paper-200">{summary.culpritSettlement.votesAgainst} 票</p></div>
            <div><p className="text-xs text-paper-500">结局</p><p className="mt-1 text-paper-200">{summary.culpritSettlement.title}</p></div>
          </div>
          {summary.culpritSettlement.verdict && <p className="mt-2 text-xs text-paper-400">{summary.culpritSettlement.verdict}</p>}
        </div>
      )}
      {(() => {
        const quizBoard = (reveal.content.quiz as GameSummary["quizResult"] | undefined) ?? summary.quizResult ?? null;
        if (!quizBoard || !summary.quiz) return null;
        const seatScores = Object.values(quizBoard.perSeat);
        const avg = seatScores.length ? seatScores.reduce((s, v) => s + v.score, 0) / seatScores.length : 0;
        const mine = mySeat !== null ? quizBoard.perSeat[String(mySeat)] : undefined;
        return (
          <div className="mx-auto mt-5 max-w-2xl rounded-xl border border-gold-400/20 bg-ink-950/60 p-4 text-left">
            <p className="text-[10px] font-semibold tracking-[0.16em] text-gold-400">QUIZ · 复盘答题成绩单</p>
            <div className="mt-3 space-y-3">
              {summary.quiz.questions.map((q) => {
                const stat = quizBoard.perQuestion.find((p) => p.questionId === q.id);
                return (
                  <div key={q.id}>
                    <p className="text-sm text-paper-200">{q.prompt}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {q.options.map((o) => {
                        const isCorrect = stat?.correctOptionId === o.id;
                        const n = stat?.counts[o.id] ?? 0;
                        return (
                          <span
                            key={o.id}
                            className={`rounded-full border px-2.5 py-0.5 text-xs ${
                              isCorrect ? "border-success-400/60 bg-success-400/10 text-success-400" : "border-paper-500/20 text-paper-400"
                            }`}
                          >
                            {o.label} ×{n}
                            {isCorrect ? " ✓" : ""}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-paper-400">
              全场平均 {avg.toFixed(1)} 分
              {mine ? ` · 我答对 ${mine.correct}/${mine.total}（加权 ${mine.score} 分）` : ""}
            </p>
          </div>
        );
      })()}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link href="/rooms/new" className="rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400">
          再来一局
        </Link>
        <Link href={`/rooms/${summary.roomCode}`} className="rounded-lg border border-gold-400/20 px-4 py-2 text-sm text-paper-200 hover:border-gold-400/50">
          回到大厅
        </Link>
      </div>
    </div>
  );
}

function EventBubble({
  ev,
  publicEvidence,
  mySeat,
  seatName,
  ttsSeats,
  onSpeak,
}: {
  ev: GameEventView;
  publicEvidence: Array<{ id: string; name: string }>;
  mySeat: number | null;
  seatName: (i: number) => string;
  ttsSeats: Set<number>;
  onSpeak: (eventSeq: string) => void;
}) {
  const mine = ev.fromSeat !== null && ev.fromSeat === mySeat;
  switch (ev.type) {
    case "phase":
      return (
        <div className="phase-arrival space-y-2">
          <div className="flex items-center gap-3 text-xs text-gold-400/70">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-gold-400/20" />
            <span className="font-semibold tracking-wide">
              {PHASE_LABEL[(ev.content.phase as string) ?? ev.phase] ?? ev.phase}
              {ev.round ? ` · 第 ${ev.round} 轮` : ""}
            </span>
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-gold-400/20" />
          </div>
          {ev.content.text && (
            <div className="rounded-2xl rounded-tl-sm border border-gold-400/25 bg-gold-400/5 px-4 py-3 text-sm">
              <p className="eyebrow">DM · 主持人</p>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed text-paper-300">{ev.content.text}</p>
            </div>
          )}
        </div>
      );
    case "speech": {
      const text = ev.content.text ?? "";
      const canSpeak = ev.fromSeat !== null && ttsSeats.has(ev.fromSeat) && text;
      const evidenceRefs = Array.isArray(ev.content.focusEvidenceIds ?? ev.content.evidenceIds) ? (ev.content.focusEvidenceIds ?? ev.content.evidenceIds) as string[] : [];
      const isInterjection = ev.content.interjection === true;
      return (
        <div className={`fade-up flex ${mine ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm sm:max-w-[82%] ${mine ? "rounded-tr-sm border border-gold-400/20 bg-gold-400/10" : "rounded-tl-sm border border-gold-400/10 bg-ink-850"}`}>
            <p className={`flex items-center text-xs ${mine ? "justify-end text-gold-400" : "text-paper-500"}`}>
              {ev.content.speakerName ?? seatName(ev.fromSeat ?? 0)}
              {isInterjection && (
                <span className="ml-1.5 rounded-full border border-secret-400/30 px-1.5 py-0.5 text-[10px] text-secret-400">插话</span>
              )}
              {canSpeak && (
                <button
                  onClick={() => onSpeak(ev.seq)}
                  title="播放语音"
                  aria-label="播放这条发言的语音"
                  className="ml-2 grid size-8 place-items-center rounded-full text-paper-500 transition hover:bg-gold-400/10 hover:text-gold-400"
                >
                  <SoundIcon className="size-4" />
                </button>
              )}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed text-paper-200">{text}</p>
            <p className="mt-2 text-xs text-paper-500">{evidenceRefs.length ? `引用公开线索：${evidenceRefs.map((id) => publicEvidence.find((clue) => clue.id === id)?.name ?? id).join("、")}` : "角色陈述"}</p>
          </div>
        </div>
      );
    }
    case "interaction":
    case "system": {
      const onlyMe = mySeat !== null && ev.visibility === `seat:${mySeat}`;
      return (
        <p className={`mx-auto w-fit rounded-full border px-3 py-1 text-center text-xs ${onlyMe ? "border-secret-400/20 bg-secret-400/5 text-secret-400" : "border-gold-400/10 bg-ink-950/70 text-paper-500"}`}>
          {ev.content.text}
          {onlyMe && <span className="ml-1.5 rounded-full border border-secret-400/30 px-1.5 py-0.5 text-[10px]">仅你可见</span>}
        </p>
      );
    }
    case "clue":
      if (ev.visibility === "public") {
        return (
          <div className="clue-card evidence-reveal mx-auto max-w-[92%] px-5 py-4 text-sm">
            <p className="text-[10px] font-semibold tracking-[0.16em] text-clue-400">
              EVIDENCE · 公开线索{typeof ev.content.publicBy === "number" ? ` · ${seatName(ev.content.publicBy)} 公布` : ""}
            </p>
            <p className="mt-2 font-semibold text-paper-50">{ev.content.clueName}</p>
            <p className="mt-1 leading-relaxed text-paper-400">{ev.content.clueContent}</p>
          </div>
        );
      }
      return (
        <p className="evidence-reveal mx-auto w-fit rounded-full border border-secret-400/20 bg-secret-400/5 px-3 py-1.5 text-center text-xs text-secret-400">
          你发现了线索「{ev.content.clueName}」（仅你可见）· 前往线索栏查看
        </p>
      );
    case "vote":
      return (
        <div className="mx-auto flex w-fit items-center gap-2 rounded-lg border border-danger-400/20 bg-danger-400/5 px-3 py-2 text-center text-sm text-paper-300">
          <span className="text-[10px] font-bold tracking-widest text-danger-400">VOTE</span>
          <span>{ev.content.text}</span>
        </div>
      );
    case "private":
      return (
        <div className={`flex ${ev.fromSeat === mySeat ? "justify-end" : "justify-start"}`}>
          <div className="max-w-[85%] rounded-2xl border border-dashed border-secret-400/40 bg-secret-400/5 px-4 py-2.5 text-sm">
            <p className="text-xs text-secret-400">
              私聊 · {ev.fromSeat === mySeat ? "你对" : `${seatName(ev.fromSeat ?? 0)} 对`} {ev.toSeat === mySeat ? "你" : seatName(ev.toSeat ?? 0)}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed text-paper-200">{ev.content.text}</p>
          </div>
        </div>
      );
    case "transfer":
      return (
        <div className={`flex ${ev.fromSeat === mySeat ? "justify-end" : "justify-start"}`}>
          <div className="max-w-[85%] rounded-2xl border border-dashed border-secret-400/40 bg-secret-400/5 px-4 py-2.5 text-sm">
            <p className="text-xs text-secret-400">
              线索转交 · {ev.fromSeat === mySeat ? `你悄悄交给了 ${seatName(ev.toSeat ?? 0)}` : `${seatName(ev.fromSeat ?? 0)} 悄悄把一张线索卡交给了你`}
            </p>
            <p className="mt-1 font-semibold text-paper-100">「{ev.content.clueName}」</p>
            {ev.content.clueContent && <p className="mt-1 whitespace-pre-wrap leading-relaxed text-paper-200">{ev.content.clueContent}</p>}
          </div>
        </div>
      );
    case "reveal":
      return null; // 复盘在主区块单独渲染
    default:
      return null;
  }
}
