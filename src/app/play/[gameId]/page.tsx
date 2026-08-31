"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  api,
  getIdentity,
  PHASE_LABEL,
  type GameEventView,
  type GameSummary,
} from "@/lib/client";

interface DmView {
  truth: { culprit: string; method: string; fullTimeline: string; keyEvidence: string[]; reveal: string };
  characters: Array<{ id: string; name: string; publicBio: string; secret: string; goal: string; timeline: string; isCulprit: boolean; seatIndex: number | null }>;
  clues: Array<{ id: string; location: string; name: string; content: string; policy: string }>;
}

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
  const lastSeq = useRef("0");
  const chatRef = useRef<HTMLDivElement>(null);

  // 1) 加载对局概要（先不带身份拿 roomId，再带身份重取私卡）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await api<GameSummary>(`/api/games/${gameId}`);
      if (cancelled) return;
      const id = getIdentity()[base.roomId];
      const seatIndex = id?.seatIndex;
      const idToken = id?.token;
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
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // 2) SSE 订阅
  useEffect(() => {
    if (!summary) return;
    const url = isDm
      ? `/api/games/${gameId}/events?dm=1&dmtoken=${dmToken ?? ""}`
      : `/api/games/${gameId}/events${mySeat !== null ? `?seat=${mySeat}&token=${myToken ?? ""}` : ""}`;
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
          // 私聊最终事件已落库，清掉该座位的流式缓冲（避免气泡滞留）
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
          // 我获得了新线索 → 刷新私卡线索列表
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
  }, [gameId, summary, mySeat, myToken, isDm, dmToken]);

  // 3) 自动滚动
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [events, deltas]);

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

  const speakText = useCallback(
    async (text: string) => {
      try {
        const r = await api<{ url: string }>("/api/tts", { method: "POST", body: JSON.stringify({ text }) });
        void new Audio(r.url).play();
      } catch (err) {
        setError(`语音生成失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    []
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

  if (!summary) return <p className="text-zinc-500">进入对局…</p>;

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
    .map((e) => ({ id: e.content.clueId!, name: e.content.clueName!, content: e.content.clueContent!, private: e.content.private as boolean }));
  const seen = new Set<string>();
  const myClueCardsUnique = myClueCards.filter((c) => !seen.has(c.id) && seen.add(c.id));

  const phaseSteps = ["READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL"];
  const phaseIdx = phaseSteps.indexOf(phase === "ENDED" ? "REVEAL" : phase);
  const aiSeatSet = new Set(summary.seats.filter((s) => s.kind === "ai").map((s) => s.index));

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr_300px]">
      {/* 左栏：场景与行动 */}
      <aside className="space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <Link href={`/rooms/${summary.roomCode}`} className="text-xs text-zinc-500 hover:text-zinc-300">
            ← 房间 {summary.roomCode}
          </Link>
          <h2 className="mt-1 font-semibold">{summary.scriptTitle}</h2>
          <div className="mt-3 flex flex-wrap gap-1 text-xs">
            {phaseSteps.map((p, i) => (
              <span
                key={p}
                className={`rounded px-1.5 py-0.5 ${
                  i < phaseIdx ? "bg-zinc-800 text-zinc-500" : i === phaseIdx ? "bg-amber-500 text-zinc-950 font-medium" : "text-zinc-600"
                }`}
              >
                {PHASE_LABEL[p]}
              </span>
            ))}
          </div>
          {!ended && (
            <p className="mt-3 text-sm text-amber-400">
              {PHASE_LABEL[phase]}
              {(phase === "SEARCH" || phase === "DISCUSSION") && ` · 第 ${summary.round} 轮`}
            </p>
          )}
        </div>

        {me && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="text-sm font-medium text-zinc-300">在场玩家</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {activeSeats.map((s) => (
                <li key={s.index} className={`flex items-center justify-between ${s.index === mySeat ? "text-amber-400" : "text-zinc-300"}`}>
                  <span>
                    {s.characterName}
                    <span className="ml-1.5 text-xs text-zinc-500">
                      {s.index === mySeat ? "（你）" : s.kind === "ai" ? "AI" : s.playerName}
                    </span>
                  </span>
                  {thinking[s.index] && <span className="text-xs text-zinc-500">思考中…</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 阶段行动区 */}
        {me && !ended && (
          <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h3 className="text-sm font-medium text-amber-400">你的行动</h3>
            {phase === "READING" && (
              <button onClick={() => void send({ type: "ready" })} className="w-full rounded-lg bg-amber-500 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">
                我已读完剧本
              </button>
            )}
            {phase === "SEARCH" && !iChoseLocation && (
              <div className="space-y-1.5">
                <p className="text-xs text-zinc-400">选择搜证地点：</p>
                {summary.locations.map((loc) => (
                  <button key={loc} onClick={() => void send({ type: "choose_location", location: loc })} className="w-full rounded-lg border border-zinc-700 px-3 py-1.5 text-left text-sm hover:border-amber-500/60">
                    {loc}
                  </button>
                ))}
              </div>
            )}
            {phase === "SEARCH" && iChoseLocation && <p className="text-xs text-zinc-400">已选择，等待其他玩家搜证…</p>}
            {phase === "VOTE" && !iVoted && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-400">指认真凶：</p>
                {activeSeats
                  .filter((s) => s.index !== mySeat)
                  .map((s) => (
                    <button
                      key={s.index}
                      onClick={() => setVoteTarget(s.index)}
                      className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm ${voteTarget === s.index ? "border-amber-500 bg-amber-500/10" : "border-zinc-700 hover:border-amber-500/60"}`}
                    >
                      {s.characterName}
                    </button>
                  ))}
                <input
                  value={voteReason}
                  onChange={(e) => setVoteReason(e.target.value)}
                  placeholder="一句话理由（可选）"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-amber-500"
                />
                <button
                  onClick={() => {
                    if (voteTarget !== null) void send({ type: "vote", target: voteTarget, reason: voteReason }).then(() => setVoteTarget(null));
                  }}
                  disabled={voteTarget === null}
                  className="w-full rounded-lg bg-amber-500 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
                >
                  投票
                </button>
              </div>
            )}
            {phase === "VOTE" && iVoted && <p className="text-xs text-zinc-400">已投票，等待其他人…</p>}
            {phase === "DISCUSSION" && summary.flow.allowPrivateChat && (
              <div className="space-y-2 border-t border-amber-500/20 pt-3">
                <p className="text-xs text-zinc-400">私聊（每对象限 {summary.flow.privateChatMessageLimit} 条）：</p>
                <select
                  value={privateTarget ?? ""}
                  onChange={(e) => setPrivateTarget(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-500"
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
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-amber-500"
                  />
                  <button
                    onClick={() => {
                      if (privateTarget !== null && privateText.trim()) {
                        void send({ type: "private_chat", toSeat: privateTarget, text: privateText });
                        setPrivateText("");
                      }
                    }}
                    disabled={privateTarget === null || !privateText.trim()}
                    className="rounded-lg bg-zinc-800 px-3 text-sm hover:bg-zinc-700 disabled:opacity-40"
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
          <div className="space-y-3 rounded-xl border border-purple-500/40 bg-purple-500/5 p-4">
            <h3 className="text-sm font-medium text-purple-300">DM 控制台</h3>
            {dmData && (
              <div className="rounded-lg bg-zinc-950/60 p-3 text-xs text-zinc-400">
                <p>
                  真凶：<span className="font-semibold text-red-400">{dmData.characters.find((c) => c.isCulprit)?.name}</span>
                </p>
                <p className="mt-1">{dmData.truth.method.slice(0, 60)}…（完整真相见右侧「真相」页）</p>
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
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm outline-none focus:border-purple-500"
              />
              <button
                onClick={() => {
                  if (dmText.trim()) {
                    void sendDm({ type: "narrate", text: dmText });
                    setDmText("");
                  }
                }}
                disabled={!dmText.trim()}
                className="rounded-lg bg-purple-500/80 px-3 text-sm font-medium text-zinc-950 hover:bg-purple-400 disabled:opacity-40"
              >
                旁白
              </button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void sendDm({ type: "nudge" })} className="flex-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:border-purple-500/60">
                催促推进
              </button>
              <button onClick={() => void sendDm({ type: "skip_turn" })} className="flex-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:border-purple-500/60">
                跳过当前回合
              </button>
            </div>
          </div>
        )}
        {!me && !isDm && !ended && (
          <p className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-500">
            你正在以观众身份观看（公开事件流）。
          </p>
        )}
      </aside>

      {/* 中栏：对话流 */}
      <section className="flex min-h-[70vh] flex-col rounded-xl border border-zinc-800 bg-zinc-900/30">
        <div ref={chatRef} className="flex-1 space-y-3 overflow-y-auto p-5" style={{ maxHeight: "72vh" }}>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm leading-relaxed text-zinc-300">
            <span className="font-semibold text-amber-400">背景</span>
            <p className="mt-2 whitespace-pre-wrap">{summary.background}</p>
          </div>

          {events.map((ev) => (
            <EventBubble
              key={ev.seq}
              ev={ev}
              mySeat={mySeat}
              seatName={seatName}
              ttsSeats={aiSeatSet}
              onSpeak={speakText}
            />
          ))}

          {/* 流式中的 AI 发言 */}
          {Object.entries(deltas).map(([seatStr, text]) =>
            text ? (
              <div key={`delta-${seatStr}`} className="fade-up flex gap-2">
                <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm">
                  <p className="text-xs text-amber-400/80">{seatName(Number(seatStr))}</p>
                  <p className="mt-1 whitespace-pre-wrap leading-relaxed text-zinc-200 typing-caret">{text}</p>
                </div>
              </div>
            ) : null
          )}

          {ended && reveal && (
            <div className="fade-up rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 text-sm">
              <h3 className="font-bold text-amber-400">真相揭晓：{reveal.content.culpritName}</h3>
              <p className="mt-2 text-zinc-300">
                {reveal.content.caught ? "凶手被指认，好人阵营胜利！" : "凶手逃脱了……凶手阵营胜利！"}
              </p>
              <p className="mt-3 whitespace-pre-wrap leading-relaxed text-zinc-400">{reveal.content.reveal}</p>
              <p className="mt-3 text-xs text-zinc-500">{reveal.content.winText}</p>
              <div className="mt-4 flex gap-3">
                <Link href="/rooms/new" className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-amber-400">
                  再来一局
                </Link>
                <Link href={`/rooms/${summary.roomCode}`} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-500">
                  回到大厅
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* 输入区 */}
        {me && (phase === "SELF_INTRO" || phase === "DISCUSSION") && !ended && (
          <div className="border-t border-zinc-800 p-4">
            {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
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
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-amber-500"
              />
              <button
                onClick={() => {
                  if (input.trim()) {
                    void send({ type: "speak", text: input });
                    setInput("");
                  }
                }}
                disabled={!input.trim()}
                className="rounded-lg bg-amber-500 px-5 text-sm font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-40"
              >
                发言
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 右栏：我的剧本 / 我的线索 / 时间线 */}
      <aside className="rounded-xl border border-zinc-800 bg-zinc-900/50">
        <div className="flex border-b border-zinc-800 text-sm">
          {(
            [
              ["script", isDm ? "真相" : me?.myCard ? "我的剧本" : "剧本"],
              ["clues", isDm ? "全部线索" : `我的线索${myClueCardsUnique.length ? ` (${myClueCardsUnique.length})` : ""}`],
              ["timeline", "时间线"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`flex-1 px-2 py-3 text-center ${tab === k ? "bg-zinc-800/60 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4 text-sm">
          {tab === "script" && isDm && (
            dmData ? (
              <div className="space-y-3 leading-relaxed text-xs">
                <section className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
                  <h4 className="font-semibold text-red-400">真相</h4>
                  <p className="mt-1 text-zinc-300">
                    真凶：{dmData.characters.find((c) => c.isCulprit)?.name} · {dmData.truth.method}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-zinc-400">{dmData.truth.fullTimeline}</p>
                  <p className="mt-2 text-zinc-500">关键证据：{dmData.truth.keyEvidence.join("、")}</p>
                </section>
                <section>
                  <h4 className="font-semibold text-zinc-400">各角色秘密</h4>
                  {dmData.characters.map((c) => (
                    <div key={c.id} className="mt-2 rounded-lg border border-zinc-800 p-2.5">
                      <p className="font-medium text-zinc-200">
                        {c.name}
                        {c.isCulprit && <span className="ml-1.5 text-red-400">← 真凶</span>}
                        {c.seatIndex !== null && <span className="ml-1.5 text-zinc-500">（座位 {c.seatIndex + 1}）</span>}
                      </p>
                      <p className="mt-1 text-zinc-400">秘密：{c.secret}</p>
                      <p className="mt-0.5 text-zinc-500">目标：{c.goal}</p>
                    </div>
                  ))}
                </section>
              </div>
            ) : (
              <p className="text-zinc-500">加载真相…</p>
            )
          )}
          {tab === "script" && !isDm && (
            me?.myCard ? (
              <div className="space-y-3 leading-relaxed">
                <section>
                  <h4 className="text-xs font-semibold text-zinc-400">背景</h4>
                  <p className="mt-1 text-zinc-300">{me.myCard.backstory}</p>
                </section>
                <section>
                  <h4 className="text-xs font-semibold text-red-400/80">你的秘密（绝不主动透露）</h4>
                  <p className="mt-1 text-zinc-300">{me.myCard.secret}</p>
                </section>
                <section>
                  <h4 className="text-xs font-semibold text-zinc-400">目标</h4>
                  <p className="mt-1 text-zinc-300">{me.myCard.goal}</p>
                </section>
                <section>
                  <h4 className="text-xs font-semibold text-zinc-400">你的时间线</h4>
                  <p className="mt-1 text-zinc-300">{me.myCard.timeline}</p>
                </section>
                {me.myCard.knowledge.length > 0 && (
                  <section>
                    <h4 className="text-xs font-semibold text-zinc-400">你额外知道</h4>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                      {me.myCard.knowledge.map((k, i) => (
                        <li key={i}>{k}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            ) : (
              <p className="whitespace-pre-wrap leading-relaxed text-zinc-400">{summary.background}</p>
            )
          )}
          {tab === "clues" && isDm && (
            <div className="space-y-2 text-xs">
              {dmData ? (
                dmData.clues.map((c) => {
                  const isPublic = events.some((e) => e.type === "clue" && e.visibility === "public" && e.content.clueId === c.id);
                  const isHeld = events.some((e) => e.type === "clue" && e.visibility !== "public" && e.content.clueId === c.id);
                  return (
                    <div key={c.id} className="rounded-lg border border-zinc-800 p-2.5">
                      <p className="font-medium text-zinc-200">
                        {c.name}
                        <span className="ml-2 text-zinc-500">[{c.location}]</span>
                        <span className={`ml-2 ${isPublic ? "text-sky-400" : isHeld ? "text-purple-400" : "text-zinc-600"}`}>
                          {isPublic ? "已公开" : isHeld ? "被持有" : "未发现"}
                        </span>
                      </p>
                      <p className="mt-1 text-zinc-400">{c.content}</p>
                    </div>
                  );
                })
              ) : (
                <p className="text-zinc-500">加载中…</p>
              )}
            </div>
          )}
          {tab === "clues" && !isDm && (
            <div className="space-y-3">
              {myClueCardsUnique.length === 0 && <p className="text-zinc-500">还没有获得任何线索。搜证阶段选择地点后在这里查看。</p>}
              {myClueCardsUnique.map((c) => {
                const isPublic = events.some((e) => e.type === "clue" && e.visibility === "public" && e.content.clueId === c.id);
                const needDecision = phase === "SEARCH" && c.private && !isPublic && !decidedClues.has(c.id);
                return (
                  <div key={c.id} className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-purple-300">{c.name}</span>
                      <span className="text-xs text-zinc-500">{isPublic ? "已公开" : "私藏"}</span>
                    </div>
                    <p className="mt-1 text-zinc-300">{c.content}</p>
                    {needDecision && (
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => {
                            setDecidedClues((s) => new Set(s).add(c.id));
                            void send({ type: "publish", clueId: c.id, publish: true });
                          }}
                          className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400"
                        >
                          当场公开
                        </button>
                        <button
                          onClick={() => {
                            setDecidedClues((s) => new Set(s).add(c.id));
                            void send({ type: "publish", clueId: c.id, publish: false });
                          }}
                          className="rounded-lg border border-zinc-700 px-3 py-1 text-xs hover:border-zinc-500"
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
            <ul className="space-y-2 text-xs text-zinc-400">
              {events
                .filter((e) => e.type === "phase" || e.type === "system" || e.type === "reveal")
                .map((e) => (
                  <li key={e.seq}>
                    <span className="text-zinc-600">{new Date(e.createdAt).toLocaleTimeString()}</span>{" "}
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
  onSpeak: (text: string) => void;
}) {
  const mine = ev.fromSeat !== null && ev.fromSeat === mySeat;
  switch (ev.type) {
    case "phase":
      return (
        <div className="fade-up space-y-2">
          <div className="flex items-center gap-3 text-xs text-zinc-600">
            <span className="h-px flex-1 bg-zinc-800" />
            <span>
              {PHASE_LABEL[(ev.content.phase as string) ?? ev.phase] ?? ev.phase}
              {ev.round ? ` · 第 ${ev.round} 轮` : ""}
            </span>
            <span className="h-px flex-1 bg-zinc-800" />
          </div>
          {ev.content.text && (
            <div className="rounded-2xl rounded-tl-sm border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm">
              <p className="text-xs font-medium text-amber-400">主持人</p>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed text-zinc-300">{ev.content.text}</p>
            </div>
          )}
        </div>
      );
    case "speech": {
      const text = ev.content.text ?? "";
      const canSpeak = ev.fromSeat !== null && ttsSeats.has(ev.fromSeat) && text;
      return (
        <div className={`fade-up flex ${mine ? "justify-end" : "justify-start"}`}>
          <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${mine ? "rounded-tr-sm bg-amber-500/15" : "rounded-tl-sm border border-zinc-800 bg-zinc-900"}`}>
            <p className={`text-xs ${mine ? "text-amber-400" : "text-zinc-500"}`}>
              {ev.content.speakerName ?? seatName(ev.fromSeat ?? 0)}
              {canSpeak && (
                <button
                  onClick={() => onSpeak(text)}
                  title="播放语音"
                  className="ml-2 rounded px-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-amber-400"
                >
                  🔊
                </button>
              )}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed text-zinc-200">{text}</p>
          </div>
        </div>
      );
    }
    case "system":
      return <p className="text-center text-xs text-zinc-600">{ev.content.text}</p>;
    case "clue":
      if (ev.visibility === "public") {
        return (
          <div className="fade-up mx-auto max-w-[90%] rounded-xl border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm">
            <p className="text-xs font-medium text-sky-400">
              公开线索{typeof ev.content.publicBy === "number" ? `（${seatName(ev.content.publicBy)} 公布）` : ""}
            </p>
            <p className="mt-1 font-medium text-zinc-200">{ev.content.clueName}</p>
            <p className="mt-1 leading-relaxed text-zinc-400">{ev.content.clueContent}</p>
          </div>
        );
      }
      return (
        <p className="text-center text-xs text-purple-400/80">你搜到了线索卡【{ev.content.clueName}】（在右侧「我的线索」中查看）</p>
      );
    case "vote":
      return <p className="text-center text-sm text-zinc-400">🗳 {ev.content.text}</p>;
    case "private":
      return (
        <div className={`flex ${ev.fromSeat === mySeat ? "justify-end" : "justify-start"}`}>
          <div className="max-w-[85%] rounded-2xl border border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-sm">
            <p className="text-xs text-amber-400/80">
              私聊 · {ev.fromSeat === mySeat ? "你对" : `${seatName(ev.fromSeat ?? 0)} 对`} {ev.toSeat === mySeat ? "你" : seatName(ev.toSeat ?? 0)}
            </p>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed text-zinc-200">{ev.content.text}</p>
          </div>
        </div>
      );
    case "reveal":
      return null; // 复盘在主区块单独渲染
    default:
      return null;
  }
}
