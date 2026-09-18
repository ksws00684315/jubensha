"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getIdentity, saveIdentity, type GameEventView, type GameSummary } from "@/lib/client";
import { gameEventsUrl } from "@/lib/join";
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
        | { kind: "delta"; seat: number | "dm"; text: string }
        | { kind: "thinking"; seat: number | "dm" | null }
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
          setDmThinking(false);
          setDmDelta("");
          setSummary((s) => (s ? { ...s, phase: ev.phase, round: ev.round, status: ev.phase === "ENDED" ? "ended" : s.status } : s));
        }
        if (ev.type === "clue" || ev.type === "speech" || ev.type === "system" || ev.type === "phase" || ev.type === "private" || ev.type === "transfer" || ev.type === "vote") {
          queueSummaryRefresh();
        }
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
        // 终局：服务端不会再推事件，主动收掉这条长连接（否则 EventSource 会一直空转重连）
        setSummary((s) => (s ? { ...s, status: "ended", phase: "ENDED" } : s));
        es.close();
      }
    };
    es.onerror = () => {
      /* EventSource 自动重连，服务端按 Last-Event-ID 补发 */
    };
    return () => es.close();
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

  // 限时倒计时：仅在截止时间进入最后 60 秒窗口后才需要每秒刷新
  useEffect(() => {
    const deadline = summary?.humanDeadline ?? null;
    if (deadline === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [summary?.humanDeadline]);

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
