"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BrandMark, SoundIcon } from "@/components/VisualIcons";
import { NarrativeBlocks, TimelineList } from "@/components/ScriptContent";
import {
  api,
  getIdentity,
  PHASE_LABEL,
  saveIdentity,
  type GameEventView,
  type GameSummary,
  type DmStructuredView,
} from "@/lib/client";
import { gameEventsUrl } from "@/lib/join";

interface DmView {
  truth: { culprit: string; method: string; fullTimeline: string; keyEvidence: string[]; reveal: string };
  characters: Array<{ id: string; name: string; publicBio: string; secret: string; goal: string; timeline: string; isCulprit: boolean; seatIndex: number | null }>;
  clues: Array<{ id: string; location: string; name: string; content: string; policy: string }>;
  structured: DmStructuredView | null;
}

type GameCue = "phase" | "clue" | "reveal";

export default function PlayPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [mySeat, setMySeat] = useState<number | null>(null);
  const [myToken, setMyToken] = useState<string | null>(null);
  const [isDm, setIsDm] = useState(false);
  const [dmToken, setDmToken] = useState<string | null>(null);
  const [dmData, setDmData] = useState<DmView | null>(null);
  const [dmText, setDmText] = useState("");
  const [events, setEvents] = useState<GameEventView[]>([]);
  const [deltas, setDeltas] = useState<Record<number, string>>({});
  const [thinking, setThinking] = useState<Record<number, boolean>>({});
  const [input, setInput] = useState("");
  const [tab, setTab] = useState<"script" | "clues" | "timeline">("script");
  const [voteTarget, setVoteTarget] = useState<number | null>(null);
  const [voteReason, setVoteReason] = useState("");
  const [privateTarget, setPrivateTarget] = useState<number | null>(null);
  const [privateText, setPrivateText] = useState("");
  const [decidedClues, setDecidedClues] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const lastSeq = useRef("0");
  const soundedSeq = useRef("0");
  const audioContext = useRef<AudioContext | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const [streamKey, setStreamKey] = useState<string | null>(null);

  const playCue = useCallback(
    (cue: GameCue, force = false) => {
      if (!soundEnabled && !force) return;
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      void context.resume();
      const notes = cue === "reveal" ? [164, 130, 329] : cue === "clue" ? [440, 659] : [220, 330];
      notes.forEach((frequency, index) => {
        const start = context.currentTime + index * (cue === "reveal" ? 0.18 : 0.1);
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = cue === "reveal" ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.3);
      });
    },
    [soundEnabled]
  );

  // 1) 加载对局概要（先不带身份拿 roomId，再带身份重取私卡）
  useEffect(() => {
    let cancelled = false;
    lastSeq.current = "0";
    setEvents([]);
    setDeltas({});
    setThinking({});
    setStreamKey(null);
    setSummary(null);
    setMySeat(null);
    setMyToken(null);
    setIsDm(false);
    setDmToken(null);
    (async () => {
      const base = await api<GameSummary>(`/api/games/${gameId}`);
      if (cancelled) return;
      const id = getIdentity()[base.roomId];
      const seatIndex = id?.seatIndex;
      const idToken = id?.token;
      if (id) {
        saveIdentity(base.roomId, id.seatIndex, id.token, id.name, { code: base.roomCode, gameId });
      }
      if (id && seatIndex === "dm") {
        setIsDm(true);
        setDmToken(idToken ?? null);
        setSummary(base);
        void api<DmView>(`/api/games/${gameId}/dm-actions?token=${idToken ?? ""}`).then(setDmData).catch(() => null);
      } else if (id && typeof seatIndex === "number" && idToken) {
        setMySeat(seatIndex);
        setMyToken(idToken);
        try {
          const mine = await api<GameSummary>(`/api/games/${gameId}?seat=${seatIndex}&token=${idToken}`);
          if (!cancelled) setSummary(mine);
        } catch {
          setSummary(base);
        }
      } else {
        setSummary(base);
      }
      if (!cancelled) setStreamKey(gameId);
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // 2) SSE 订阅：不依赖 summary，避免阶段刷新时拆掉连接导致 lastSeq 丢失
  useEffect(() => {
    if (streamKey !== gameId) return;
    const url = gameEventsUrl(gameId, {
      dm: isDm,
      dmToken,
      seat: mySeat,
      token: myToken,
      lastSeq: lastSeq.current,
    });
    const es = new EventSource(url);
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data) as
        | { kind: "event"; event: GameEventView }
        | { kind: "delta"; seat: number; text: string }
        | { kind: "thinking"; seat: number | null }
        | { kind: "end" }
        | { kind: "hello" };
      if (msg.kind === "event") {
        if (BigInt(msg.event.seq) <= BigInt(lastSeq.current)) return;
        lastSeq.current = msg.event.seq;
        const ev = msg.event;
        setEvents((prev) => [...prev, ev]);
        if (ev.type === "speech" && ev.fromSeat !== null) {
          setDeltas((d) => {
            const { [ev.fromSeat as number]: _drop, ...rest } = d;
            void _drop;
            return rest;
          });
          setThinking((t) => ({ ...t, [ev.fromSeat as number]: false }));
        }
        if (ev.type === "private" && ev.fromSeat !== null) {
          setDeltas((d) => {
            const { [ev.fromSeat as number]: _drop, ...rest } = d;
            void _drop;
            return rest;
          });
        }
        if (ev.type === "phase" || ev.type === "reveal") {
          setSummary((s) => (s ? { ...s, phase: ev.phase, round: ev.round, status: ev.phase === "ENDED" ? "ended" : s.status } : s));
        }
        if (ev.type === "clue" && ev.visibility === `seat:${mySeat}`) {
          void api<GameSummary>(`/api/games/${gameId}?seat=${mySeat}&token=${myToken ?? ""}`).then(setSummary).catch(() => null);
        }
      } else if (msg.kind === "delta") {
        setDeltas((d) => ({ ...d, [msg.seat]: (d[msg.seat] ?? "") + msg.text }));
      } else if (msg.kind === "thinking") {
        setThinking((t) => {
          const next = { ...t };
          if (msg.seat === null) {
            for (const k of Object.keys(next)) next[Number(k)] = false;
          } else {
            next[msg.seat] = true;
          }
          return next;
        });
      }
    };
    es.onerror = () => {
      /* EventSource 自动重连，服务端按 Last-Event-ID 补发 */
    };
    return () => es.close();
  }, [gameId, streamKey, mySeat, myToken, isDm, dmToken]);

  // 3) 自动滚动
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [events, deltas]);

  useEffect(() => {
    const newest = events.at(-1);
    if (!newest || BigInt(newest.seq) <= BigInt(soundedSeq.current)) return;
    soundedSeq.current = newest.seq;
    if (newest.type === "phase") playCue("phase");
    if (newest.type === "clue") playCue("clue");
    if (newest.type === "reveal") playCue("reveal");
  }, [events, playCue]);

  useEffect(
    () => () => {
      void audioContext.current?.close();
    },
    []
  );

  const send = useCallback(
    async (action: Record<string, unknown>) => {
      if (mySeat === null) return;
      setError(null);
      try {
        const res = await api<{ ok: boolean; error?: string }>(`/api/games/${gameId}/actions`, {
          method: "POST",
          body: JSON.stringify({ seatIndex: mySeat, token: myToken, action }),
        });
        if (!res.ok) setError(res.error ?? "操作失败");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [gameId, mySeat, myToken]
  );

  const speakEvent = useCallback(
    async (eventSeq: string) => {
      try {
        const r = await api<{ url: string }>("/api/tts", {
          method: "POST",
          body: JSON.stringify({ gameId, eventSeq }),
        });
        void new Audio(r.url).play();
      } catch (err) {
        setError(`语音生成失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [gameId]
  );

  const sendDm = useCallback(
    async (action: { type: "narrate" | "nudge" | "skip_turn"; text?: string }) => {
      if (!isDm) return;
      setError(null);
      try {
        const res = await api<{ ok: boolean; error?: string }>(`/api/games/${gameId}/dm-actions`, {
          method: "POST",
          body: JSON.stringify({ token: dmToken, action }),
        });
        if (!res.ok) setError(res.error ?? "操作失败");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [gameId, isDm, dmToken]
  );

  if (!summary) return <p className="text-paper-500">进入对局…</p>;

  const phase = summary.phase;
  const ended = phase === "ENDED" || events.some((e) => e.type === "reveal");
  const me = mySeat !== null ? summary.seats[mySeat] : null;
  const activeSeats = summary.seats.filter((s) => s.kind !== "empty");
  const seatName = (i: number) => {
    const s = summary.seats[i];
    return s?.characterName ?? s?.playerName ?? `座位${i + 1}`;
  };
  const iChoseLocation = events.some(
    (e) => e.type === "system" && e.visibility === `seat:${mySeat}` && e.round === summary.round && (e.content.text ?? "").startsWith("你选择了")
  );
  const iVoted = events.some((e) => e.type === "vote" && e.fromSeat === mySeat);
  const reveal = events.findLast((e) => e.type === "reveal");

  // 我的线索卡（从私发线索事件中取内容）
  const myClueCards = events
    .filter((e) => e.type === "clue" && e.visibility === `seat:${mySeat}` && e.content.clueId)
    .map((e) => ({ id: e.content.clueId!, name: e.content.clueName!, content: e.content.clueContent!, private: e.content.private as boolean, structured: summary.myCluesV2.find((clue) => clue.id === e.content.clueId) ?? null }));
  const seen = new Set<string>();
  const myClueCardsUnique = myClueCards.filter((c) => !seen.has(c.id) && seen.add(c.id));

  const phaseSteps = ["READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL"];
  const phaseIdx = phaseSteps.indexOf(phase === "ENDED" ? "REVEAL" : phase);
  const aiSeatSet = new Set(summary.seats.filter((s) => s.kind === "ai").map((s) => s.index));
  const showLeftRail = Boolean(me || isDm || !ended);

  return (
    <div className="game-shell min-w-0 space-y-4">
      <section className="game-panel min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="size-9 shrink-0 text-gold-400" />
            <div className="min-w-0">
              <Link href={`/rooms/${summary.roomCode}`} className="text-[10px] font-semibold tracking-[0.18em] text-paper-500 transition hover:text-gold-400">
                ROOM {summary.roomCode} · 返回房间
              </Link>
              <h1 className="truncate text-lg font-semibold text-paper-50">{summary.scriptTitle}</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!ended && (
              <div className="text-right">
                <p className="text-[10px] font-semibold tracking-[0.16em] text-paper-500">CURRENT ACT</p>
                <p className="text-sm font-medium text-gold-400">
                  {PHASE_LABEL[phase]}
                  {(phase === "SEARCH" || phase === "DISCUSSION") && ` · 第 ${summary.round} 轮`}
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                if (next) playCue("phase", true);
              }}
              aria-label={soundEnabled ? "关闭游戏音效" : "开启游戏音效"}
              title={soundEnabled ? "关闭游戏音效" : "开启游戏音效"}
              className={`grid size-9 place-items-center rounded-full border transition ${soundEnabled ? "border-gold-400/40 bg-gold-400/10 text-gold-400" : "border-gold-400/15 text-paper-500 hover:text-paper-200"}`}
            >
              <SoundIcon muted={!soundEnabled} className="size-4" />
            </button>
          </div>
        </div>
        <div className="max-w-full overflow-x-auto border-t border-gold-400/10 px-4 py-4 sm:px-6">
          <div className="phase-rail">
            {phaseSteps.map((p, i) => {
              const state = i < phaseIdx ? "done" : i === phaseIdx ? "active" : "upcoming";
              return (
                <div key={p} className="phase-node" data-state={state}>
                  <span className="phase-node__dot">{state === "done" ? "✓" : String(i + 1).padStart(2, "0")}</span>
                  <span>{PHASE_LABEL[p]}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className={`grid min-w-0 gap-4 ${showLeftRail ? "xl:grid-cols-[250px_minmax(0,1fr)_310px]" : "xl:grid-cols-[minmax(0,1fr)_310px]"}`}>
      {/* 左栏：场景与行动 */}
      {showLeftRail && <aside className="space-y-4">
        {me && (
          <div className="game-panel p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-paper-200">在场玩家</h3>
              <span className="text-[10px] font-semibold tracking-widest text-success-400">{activeSeats.length} ONLINE</span>
            </div>
            <ul className="mt-2 space-y-1.5 text-sm">
              {activeSeats.map((s) => (
                <li key={s.index} className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${s.index === mySeat ? "bg-gold-400/7 text-gold-400" : "text-paper-200"}`}>
                  <span className="min-w-0 truncate">
                    {s.characterName}
                    <span className="ml-1.5 text-xs text-paper-500">
                      {s.index === mySeat ? "（你）" : s.kind === "ai" ? "AI" : s.playerName}
                    </span>
                  </span>
                  {thinking[s.index] && <span className="thinking-dots shrink-0 text-xs text-secret-400">思考中</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 阶段行动区 */}
        {me && !ended && (
          <div className="game-panel space-y-3 border-gold-400/30 bg-gold-400/5 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gold-400">你的行动</h3>
              <span className="size-1.5 animate-pulse rounded-full bg-gold-400 shadow-[0_0_10px_rgba(238,185,88,.8)]" />
            </div>
            {phase === "READING" && (
              <button onClick={() => void send({ type: "ready" })} className="w-full rounded-lg bg-gold-500 py-2.5 text-sm font-semibold text-ink-950 hover:bg-gold-400">
                我已读完剧本
              </button>
            )}
            {phase === "SEARCH" && !iChoseLocation && (
              <div className="space-y-1.5">
                <p className="text-xs text-paper-400">选择搜证地点：</p>
                {summary.locations.map((loc) => (
                  <button key={loc} onClick={() => void send({ type: "choose_location", location: loc })} className="w-full rounded-lg border border-clue-400/20 bg-clue-400/5 px-3 py-2 text-left text-sm text-paper-200 transition hover:border-clue-400/60 hover:text-clue-400">
                    {loc}
                  </button>
                ))}
              </div>
            )}
            {phase === "SEARCH" && iChoseLocation && <p className="text-xs text-paper-400">已选择，等待其他玩家搜证…</p>}
            {phase === "VOTE" && !iVoted && (
              <div className="space-y-2">
                <p className="text-xs text-paper-400">指认真凶：</p>
                {activeSeats
                  .filter((s) => s.index !== mySeat)
                  .map((s) => (
                    <button
                      key={s.index}
                      onClick={() => setVoteTarget(s.index)}
                      className={`vote-target w-full rounded-lg border px-3 py-2 text-left text-sm ${voteTarget === s.index ? "border-danger-400/70 bg-danger-400/10 text-danger-400" : "border-gold-400/15 text-paper-200 hover:border-danger-400/40"}`}
                    >
                      {s.characterName}
                    </button>
                  ))}
                <input
                  value={voteReason}
                  onChange={(e) => setVoteReason(e.target.value)}
                  placeholder="一句话理由（可选）"
                  className="w-full rounded-lg border border-danger-400/20 bg-ink-950/80 px-3 py-2 text-sm text-paper-50 outline-none placeholder:text-paper-500 focus:border-danger-400"
                />
                <button
                  onClick={() => {
                    if (voteTarget !== null) void send({ type: "vote", target: voteTarget, reason: voteReason }).then(() => setVoteTarget(null));
                  }}
                  disabled={voteTarget === null}
                  className="w-full rounded-lg bg-danger-400 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40"
                >
                  投票
                </button>
              </div>
            )}
            {phase === "VOTE" && iVoted && <p className="text-xs text-paper-400">已投票，等待其他人…</p>}
            {phase === "DISCUSSION" && summary.flow.allowPrivateChat && (
              <div className="space-y-2 border-t border-secret-400/20 pt-3">
                <p className="text-xs text-secret-400">私聊（每对象限 {summary.flow.privateChatMessageLimit} 条）：</p>
                <select
                  value={privateTarget ?? ""}
                  onChange={(e) => setPrivateTarget(Number(e.target.value))}
                  className="w-full rounded-lg border border-secret-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-secret-400"
                >
                  <option value="" disabled>
                    选择对象…
                  </option>
                  {activeSeats
                    .filter((s) => s.index !== mySeat)
                    .map((s) => (
                      <option key={s.index} value={s.index}>
                        {s.characterName}
                      </option>
                    ))}
                </select>
                <div className="flex gap-2">
                  <input
                    value={privateText}
                    onChange={(e) => setPrivateText(e.target.value)}
                    placeholder="悄悄话…"
                    className="min-w-0 flex-1 rounded-lg border border-secret-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-secret-400"
                  />
                  <button
                    onClick={() => {
                      if (privateTarget !== null && privateText.trim()) {
                        void send({ type: "private_chat", toSeat: privateTarget, text: privateText });
                        setPrivateText("");
                      }
                    }}
                    disabled={privateTarget === null || !privateText.trim()}
                    className="rounded-lg bg-secret-400/20 px-3 text-sm text-secret-400 hover:bg-secret-400/30 disabled:opacity-40"
                  >
                    发送
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {/* 真人 DM 控制台 */}
        {isDm && !ended && (
          <div className="game-panel space-y-3 border-secret-400/40 bg-secret-400/5 p-4">
            <h3 className="text-sm font-medium text-secret-400">DM 控制台</h3>
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
                value={dmText}
                onChange={(e) => setDmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && dmText.trim()) {
                    void sendDm({ type: "narrate", text: dmText });
                    setDmText("");
                  }
                }}
                placeholder="以 DM 身份向全场旁白…"
                className="min-w-0 flex-1 rounded-lg border border-secret-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-secret-400"
              />
              <button
                onClick={() => {
                  if (dmText.trim()) {
                    void sendDm({ type: "narrate", text: dmText });
                    setDmText("");
                  }
                }}
                disabled={!dmText.trim()}
                className="rounded-lg bg-secret-400 px-3 text-sm font-medium text-ink-950 hover:brightness-110 disabled:opacity-40"
              >
                旁白
              </button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void sendDm({ type: "nudge" })} className="flex-1 rounded-lg border border-secret-400/20 px-3 py-1.5 text-xs text-paper-300 hover:border-secret-400/60">
                催促推进
              </button>
              <button onClick={() => void sendDm({ type: "skip_turn" })} className="flex-1 rounded-lg border border-secret-400/20 px-3 py-1.5 text-xs text-paper-300 hover:border-secret-400/60">
                跳过当前回合
              </button>
            </div>
          </div>
        )}
        {!me && !isDm && !ended && (
          <p className="game-panel p-4 text-xs text-paper-500">
            你正在以观众身份观看（公开事件流）。若你是本局玩家，回{" "}
            <Link href={`/rooms/${summary.roomCode}`} className="text-gold-400 hover:underline">
              房间 {summary.roomCode}
            </Link>{" "}
            用入座时的昵称认领座位。
          </p>
        )}
      </aside>}

      {/* 中栏：对话流 */}
      <section className="game-panel flex min-h-[70vh] min-w-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-gold-400/10 px-5 py-3">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.18em] text-paper-500">LIVE SCENE</p>
            <h2 className="text-sm font-medium text-paper-200">现场记录</h2>
          </div>
          <span className="flex items-center gap-2 text-[10px] font-semibold tracking-widest text-success-400">
            <span className="size-1.5 rounded-full bg-success-400 shadow-[0_0_8px_rgba(102,196,154,.75)]" /> LIVE
          </span>
        </div>
        <div ref={chatRef} className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-5" style={{ maxHeight: "72vh" }}>
          <div className="case-briefing p-4 text-sm leading-relaxed text-paper-300">
            <span className="eyebrow">Case Briefing · 案情背景</span>
            {summary.scriptV2 ? (
              <NarrativeBlocks blocks={summary.scriptV2.background} className="mt-2" />
            ) : (
              <p className="mt-2 whitespace-pre-wrap">{summary.background}</p>
            )}
          </div>

          {events.map((ev) => (
            <EventBubble
              key={ev.seq}
              ev={ev}
              mySeat={mySeat}
              seatName={seatName}
              ttsSeats={aiSeatSet}
              onSpeak={speakEvent}
            />
          ))}

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

          {ended && reveal && (
            <div className="reveal-stage reveal-curtain p-6 text-center text-sm sm:p-8">
              <p className="eyebrow text-danger-400">Final Reveal · 真相揭晓</p>
              <BrandMark className="mx-auto mt-5 size-14 text-danger-400" />
              <h3 className="mt-3 text-2xl font-bold text-paper-50">真凶：{reveal.content.culpritName}</h3>
              <p className="mt-2 font-medium text-danger-400">
                {reveal.content.caught ? "凶手被指认，好人阵营胜利！" : "凶手逃脱了……凶手阵营胜利！"}
              </p>
              <p className="mx-auto mt-4 max-w-2xl whitespace-pre-wrap text-left leading-7 text-paper-300">{reveal.content.reveal}</p>
              <p className="mt-4 text-xs text-paper-500">{reveal.content.winText}</p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Link href="/rooms/new" className="rounded-lg bg-gold-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400">
                  再来一局
                </Link>
                <Link href={`/rooms/${summary.roomCode}`} className="rounded-lg border border-gold-400/20 px-4 py-2 text-sm text-paper-200 hover:border-gold-400/50">
                  回到大厅
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* 输入区 */}
        {me && (phase === "SELF_INTRO" || phase === "DISCUSSION") && !ended && (
          <div className="border-t border-gold-400/10 bg-ink-950/45 p-4">
            {error && <p className="mb-2 text-xs text-danger-400">{error}</p>}
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) {
                    void send({ type: "speak", text: input });
                    setInput("");
                  }
                }}
                placeholder={phase === "SELF_INTRO" ? "以角色的身份介绍自己…" : "以角色的身份发言…（随时可以插话）"}
                className="min-w-0 flex-1 rounded-lg border border-gold-400/15 bg-ink-950 px-3 py-2.5 text-sm text-paper-50 outline-none placeholder:text-paper-500 focus:border-gold-400"
              />
              <button
                onClick={() => {
                  if (input.trim()) {
                    void send({ type: "speak", text: input });
                    setInput("");
                  }
                }}
                disabled={!input.trim()}
                className="rounded-lg bg-gold-500 px-5 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
              >
                发言
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 右栏：我的剧本 / 我的线索 / 时间线 */}
      <aside className="game-panel overflow-hidden">
        <div className="flex border-b border-gold-400/10 text-sm">
          {(
            [
              ["script", isDm ? "真相" : me?.myCard ? "我的剧本" : "剧本"],
              ["clues", isDm ? "全部线索" : `我的线索${myClueCardsUnique.length ? ` (${myClueCardsUnique.length})` : ""}`],
              ["timeline", "时间线"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`relative flex-1 px-2 py-3 text-center transition ${tab === k ? "bg-gold-400/7 text-gold-400 after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-gold-400" : "text-paper-500 hover:text-paper-200"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4 text-sm">
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
                          私藏
                        </button>
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
      </div>
    </div>
  );
}

function EventBubble({
  ev,
  mySeat,
  seatName,
  ttsSeats,
  onSpeak,
}: {
  ev: GameEventView;
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
      return (
        <div className={`fade-up flex ${mine ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm sm:max-w-[82%] ${mine ? "rounded-tr-sm border border-gold-400/20 bg-gold-400/10" : "rounded-tl-sm border border-gold-400/10 bg-ink-850"}`}>
            <p className={`flex items-center text-xs ${mine ? "justify-end text-gold-400" : "text-paper-500"}`}>
              {ev.content.speakerName ?? seatName(ev.fromSeat ?? 0)}
              {canSpeak && (
                <button
                  onClick={() => onSpeak(ev.seq)}
                  title="播放语音"
                  className="ml-2 grid size-6 place-items-center rounded-full text-paper-500 transition hover:bg-gold-400/10 hover:text-gold-400"
                >
                  <SoundIcon className="size-3.5" />
                </button>
              )}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed text-paper-200">{text}</p>
          </div>
        </div>
      );
    }
    case "system":
      return <p className="mx-auto w-fit rounded-full border border-gold-400/10 bg-ink-950/70 px-3 py-1 text-center text-[11px] text-paper-500">{ev.content.text}</p>;
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
          获得私密线索「{ev.content.clueName}」· 前往线索栏查看
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
    case "reveal":
      return null; // 复盘在主区块单独渲染
    default:
      return null;
  }
}
