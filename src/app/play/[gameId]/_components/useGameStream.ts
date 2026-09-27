"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getIdentity, saveIdentity, type GameEventView, type GameSummary } from "@/lib/client";
import { gameEventsUrl } from "@/lib/game-events-url";
import type { DmStructuredView } from "@/lib/client";

export interface DmView {
  truth: { culprit: string; method: string; fullTimeline: string; keyEvidence: string[]; reveal: string };
  characters: Array<{ id: string; name: string; publicBio: string; secret: string; goal: string; timeline: string; isCulprit: boolean; seatIndex: number | null }>;
  clues: Array<{ id: string; location: string; name: string; content: string; policy: string }>;
  structured: DmStructuredView | null;
  hostGuide?: { stallBreakers: Array<{ condition: string; hint: string }> } | null;
}

export type GameCue = "phase" | "clue" | "reveal";

/**
 * ★ 对局现场流（批次 I3 自 play/[gameId]/page.tsx 拆出）★
 * 只管"收"：身份认领 → 概要加载 → SSE 订阅（事件/流式 delta/思考态/终局收流）
 * → 尾随刷新（300ms 合并）→ 音效提示 → 限时倒计时时钟。
 * "发"（发言/投票/DM 指令等动作）留在页面，经 setSummary 同步本席视角。
 */
export function useGameStream(gameId: string, retryKey: number) {
  const [summary, setSummary] = useState<GameSummary | null>(null);
  const [mySeat, setMySeat] = useState<number | null>(null);
  const [myToken, setMyToken] = useState<string | null>(null);
  const [isDm, setIsDm] = useState(false);
  const [dmToken, setDmToken] = useState<string | null>(null);
  const [dmData, setDmData] = useState<DmView | null>(null);
  const [events, setEvents] = useState<GameEventView[]>([]);
  const [deltas, setDeltas] = useState<Record<number, string>>({});
  const [thinking, setThinking] = useState<Record<number, boolean>>({});
  const [dmThinking, setDmThinking] = useState(false);
  const [dmDelta, setDmDelta] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastSeq = useRef("0");
  const soundedSeq = useRef("0");
  const audioContext = useRef<AudioContext | null>(null);
  const summaryRefreshTimer = useRef<NodeJS.Timeout | null>(null);

  // 事件到达只安排一次"尾随刷新"：300ms 窗口内的多个事件合并为一次概要请求，
  // 避免每条事件都全量重拉（独立审查 M6 请求风暴）
  const queueSummaryRefresh = useCallback(() => {
    if (summaryRefreshTimer.current) return;
    summaryRefreshTimer.current = setTimeout(() => {
      summaryRefreshTimer.current = null;
      const q = mySeat !== null ? `?seat=${mySeat}` : "";
      void api<GameSummary>(`/api/games/${gameId}${q}`, mySeat !== null ? { headers: { "x-seat-token": myToken ?? "" } } : undefined)
        .then(setSummary)
        .catch(() => null);
    }, 300);
  }, [gameId, mySeat, myToken]);

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
    setSummary(null);
    setMySeat(null);
    setMyToken(null);
    setIsDm(false);
    setDmToken(null);
    setLoadError(null);
    setStreamKey(null);
    (async () => {
      try {
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
          void api<DmView>(`/api/games/${gameId}/dm-actions`, { headers: { "x-dm-token": idToken ?? "" } }).then(setDmData).catch(() => null);
        } else if (id && typeof seatIndex === "number" && idToken) {
          setMySeat(seatIndex);
          setMyToken(idToken);
          try {
            const mine = await api<GameSummary>(`/api/games/${gameId}?seat=${seatIndex}`, { headers: { "x-seat-token": idToken } });
            if (!cancelled) setSummary(mine);
          } catch {
            setSummary(base);
          }
        } else {
          setSummary(base);
        }
        if (!cancelled) setStreamKey(gameId);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, retryKey]);

  // 2) SSE 订阅：不依赖 summary，避免阶段刷新时拆掉连接导致 lastSeq 丢失；
  // streamKey 门控——身份认领解析完成（座位/DM 参数就绪）后才建流，
  // 否则观战流会先把 lastSeq 推进到只有公开事件的位置，座位私有事件将错发。
  //
  // 凭证是一次性票据（60s、用后即废），每次建连都得重新换票，所以重连由本 hook 接管，
  // 不能再交给 EventSource 的自动重连——它会拿同一张已消费的 ticket 反复重试。
  // 续传位置走 lastSeq 查询参数（服务端与 Last-Event-ID 头等价）。
  useEffect(() => {
    if (streamKey !== gameId) return;
    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retries = 0;
    let endAfterSeq: string | null = null;

    const closeSocket = () => {
      es?.close();
      es = null;
    };
    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      const delay = Math.min(1_000 * 2 ** retries, 15_000);
      retries += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };
    const finishEndedStream = () => {
      setSummary((s) => (s ? { ...s, status: "ended", phase: "ENDED" } : s));
      closeSocket();
    };

    const handleMessage = (m: MessageEvent) => {
      const msg = JSON.parse(m.data) as
        | { kind: "event"; event: GameEventView }
        | { kind: "delta"; seat: number | "dm"; text: string; audience?: "public" | number }
        | { kind: "thinking"; seat: number | "dm" | null; audience?: "public" | number }
        | { kind: "end"; lastEventSeq?: string }
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
          setDmThinking(false);
          setDmDelta("");
          setSummary((s) => (s ? { ...s, phase: ev.phase, round: ev.round, status: ev.phase === "ENDED" ? "ended" : s.status } : s));
        }
        if (ev.type === "clue" || ev.type === "speech" || ev.type === "system" || ev.type === "phase" || ev.type === "private" || ev.type === "transfer" || ev.type === "vote" || ev.type === "reveal") {
          queueSummaryRefresh();
        }
        if (endAfterSeq && BigInt(lastSeq.current) >= BigInt(endAfterSeq)) finishEndedStream();
      } else if (msg.kind === "delta") {
        if (msg.seat === "dm") setDmDelta((t) => t + msg.text);
        else setDeltas((d) => ({ ...d, [msg.seat as number]: (d[msg.seat as number] ?? "") + msg.text }));
      } else if (msg.kind === "thinking") {
        if (msg.seat === "dm") {
          setDmThinking(true);
        } else if (msg.seat === null) {
          setDmThinking(false);
          setThinking((t) => {
            const next = { ...t };
            for (const k of Object.keys(next)) next[Number(k)] = false;
            return next;
          });
        } else {
          setThinking((t) => ({ ...t, [msg.seat as number]: true }));
        }
      } else if (msg.kind === "end") {
        if (msg.lastEventSeq && BigInt(lastSeq.current) < BigInt(msg.lastEventSeq)) {
          endAfterSeq = msg.lastEventSeq;
          return;
        }
        // 终局：服务端不会再推事件，主动收掉这条长连接（否则重连逻辑会让它一直空转）
        finishEndedStream();
      }
    };

    const openSocket = (url: string) => {
      closeSocket();
      const socket = new EventSource(url);
      es = socket;
      socket.onopen = () => {
        retries = 0;
      };
      socket.onmessage = handleMessage;
      socket.onerror = () => {
        closeSocket();
        scheduleReconnect();
      };
    };

    /** 公开观战流：没有凭证，也就没有 ticket 可换。 */
    const openPublicSocket = () => openSocket(gameEventsUrl(gameId, { lastSeq: lastSeq.current }));

    const connect = async () => {
      if (disposed) return;
      const wantsView = isDm ? !!dmToken : mySeat !== null && !!myToken;
      if (!wantsView) {
        openPublicSocket();
        return;
      }
      try {
        const res = await fetch(`/api/games/${gameId}/stream-ticket`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(isDm ? { "x-dm-token": dmToken ?? "" } : { "x-seat-token": myToken ?? "" }),
          },
          body: JSON.stringify(isDm ? { dm: true } : { seat: mySeat }),
        });
        // 凭证不被认同时降级为公开流，与旧版「token 校验不过就当观战」一致；
        // 其余失败（网络、5xx、限流）不能降级——那会让本席静默丢掉私有事件，退回重试。
        if (res.status === 403 || res.status === 404) {
          openPublicSocket();
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { ticket?: string };
        if (!data.ticket) throw new Error("stream-ticket 响应缺少 ticket");
        if (disposed) return;
        openSocket(gameEventsUrl(gameId, { ticket: data.ticket, lastSeq: lastSeq.current }));
      } catch {
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeSocket();
    };
  }, [gameId, streamKey, mySeat, myToken, isDm, dmToken, queueSummaryRefresh]);

  // 新事件的音效提示（阶段/线索/揭晓三档）
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

  // 游戏总计时与人类回合倒计时共用一个时钟，避免页面同时维护多个 interval。
  useEffect(() => {
    if (!summary?.startedAt) return;
    setNow(Date.now());
    if (summary.endedAt || summary.phase === "ENDED" || summary.status === "ended") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [summary?.startedAt, summary?.endedAt, summary?.phase, summary?.status, summary?.humanDeadline]);

  return {
    summary,
    setSummary,
    mySeat,
    myToken,
    isDm,
    dmToken,
    dmData,
    events,
    deltas,
    thinking,
    dmThinking,
    dmDelta,
    loadError,
    soundEnabled,
    setSoundEnabled,
    playCue,
    now,
  };
}
