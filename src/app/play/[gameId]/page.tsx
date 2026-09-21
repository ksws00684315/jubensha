"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BrandMark, SoundIcon } from "@/components/VisualIcons";
import { api, PHASE_LABEL, type GameSummary } from "@/lib/client";
import { countdownRemaining, formatCountdown } from "@/lib/human-timeout";
import { ChatFeed } from "./_components/ChatFeed";
import { DmConsole, type DmAction } from "./_components/DmConsole";
import { InfoRail } from "./_components/InfoRail";
import { useGameStream } from "./_components/useGameStream";
import { VotePanel } from "./_components/VotePanel";
import type { GameEventView } from "@/lib/client";

/**
 * ★ 对局页编排层（批次 I3 拆分后）★
 * 页面保留：身份动作（send/发言/私信/DM 指令/TTS）+ 左栏「你的行动」阶段面板 + 三栏组装。
 * 现场流与展示已拆入 _components/：useGameStream（加载+SSE+音效+倒计时）、
 * ChatFeed（事件流/输入区/复盘）、DmConsole（真人主持台）、VotePanel（终局投票/答题）、
 * InfoRail（剧本/线索/时间线页签）。
 */
export default function PlayPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [retryKey, setRetryKey] = useState(0);
  const { setSummary, ...stream } = useGameStream(gameId, retryKey);
  const { summary, mySeat, myToken, isDm, dmToken, dmData, events, deltas, thinking, dmThinking, dmDelta, loadError, soundEnabled, setSoundEnabled, playCue, now } = stream;

  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendingLabel, setSendingLabel] = useState("正在提交…");
  const [input, setInput] = useState("");
  const [askTarget, setAskTarget] = useState<number | null>(null);
  const [askEvidence, setAskEvidence] = useState<string[]>([]);
  const [askText, setAskText] = useState("");
  const [skillActiveId, setSkillActiveId] = useState<string | null>(null);
  const [skillToSeat, setSkillToSeat] = useState<number | null>(null);
  const [skillText, setSkillText] = useState("");
  const sendNoticeTimer = useRef<NodeJS.Timeout | null>(null);

  const send = useCallback(
    async (action: Record<string, unknown>) => {
      if (mySeat === null) return false;
      setError(null);
      setSending(true);
      const type = action.type;
      setSendingLabel(type === "choose_location" ? "正在提交地点，AI 正在后台搜证…" : type === "vote" ? "正在提交投票…" : "正在提交操作…");
      if (sendNoticeTimer.current) clearTimeout(sendNoticeTimer.current);
      sendNoticeTimer.current = setTimeout(() => setSendingLabel("服务器响应较慢，仍在处理，请勿重复点击…"), 1500);
      try {
        const res = await api<{ ok: boolean; error?: string }>(`/api/games/${gameId}/actions`, {
          method: "POST",
          body: JSON.stringify({ seatIndex: mySeat, token: myToken, action }),
        });
        if (!res.ok) {
          setError(res.error ?? "操作失败");
          return false;
        }
        const mine = await api<GameSummary>(`/api/games/${gameId}?seat=${mySeat}`, { headers: { "x-seat-token": myToken ?? "" } });
        setSummary(mine);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        if (sendNoticeTimer.current) clearTimeout(sendNoticeTimer.current);
        setSending(false);
      }
    },
    [gameId, mySeat, myToken, setSummary]
  );

  /** 发言：发送成功才清空输入，失败保留文本便于重试（独立审查 H2）。 */
  const submitSpeak = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    if (await send({ type: "speak", text })) setInput("");
  }, [input, send]);

  const speakEvent = useCallback(
    async (eventSeq: string) => {
      try {
        const r = await api<{ url: string }>("/api/tts", {
          method: "POST",
          body: JSON.stringify({
            gameId,
            eventSeq,
            // 合成接口需要本局凭证（玩家座位 token 或真人主持 token）
            seat: mySeat ?? undefined,
            token: myToken ?? undefined,
            dm: isDm || undefined,
            dmToken: dmToken ?? undefined,
          }),
        });
        void new Audio(r.url).play();
      } catch (err) {
        setError(`语音生成失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [gameId, mySeat, myToken, isDm, dmToken]
  );

  const sendWhisper = useCallback(
    async (toSeat: number, text: string) => {
      if (mySeat === null || !text.trim()) return false;
      setError(null);
      try {
        const res = await api<{ ok: boolean; error?: string }>(`/api/games/${gameId}/actions`, {
          method: "POST",
          body: JSON.stringify({ seatIndex: mySeat, token: myToken, action: { type: "private_chat", toSeat, text } }),
        });
        if (!res.ok) {
          setError(res.error ?? "发送失败");
          return false;
        }
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [gameId, mySeat, myToken]
  );

  const sendDm = useCallback(
    async (action: DmAction) => {
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

  if (!summary)
    return loadError ? (
      <div className="game-panel mx-auto mt-16 max-w-md p-6 text-center">
        <p className="text-sm text-danger-400">对局加载失败：{loadError}</p>
        <button
          onClick={() => setRetryKey((k) => k + 1)}
          className="mt-4 rounded-lg bg-gold-400 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-gold-300"
        >
          重试
        </button>
      </div>
    ) : (
      <p className="text-paper-500">进入对局…</p>
    );

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
  const voteMode = summary.voteMode ?? "culprit";
  const quizDone = summary.quiz !== null && summary.quiz.myAnswers !== null;
  const reveal: GameEventView | undefined = events.findLast((e) => e.type === "reveal");
  const answering = phase === "DISCUSSION" && summary.pendingAnswer?.toSeat === mySeat;
  const mySpeakTurn =
    (phase === "SELF_INTRO" || phase === "DISCUSSION") && summary.turnSeat === mySeat && !summary.pendingAnswer;
  const canSpeak = Boolean(answering || mySpeakTurn);
  const speakPlaceholder = answering
    ? "当众回答这个问题…"
    : phase === "SELF_INTRO"
      ? "以角色的身份介绍自己…"
      : mySpeakTurn
        ? "当众陈述（提问请用左侧）…"
        : "还没轮到你发言";

  // 限时倒计时（最后 60 秒起）与「已被自动跳过」横幅（OPT-01）
  const deadlineLeft = countdownRemaining(summary.humanDeadline, now);
  const deadlinePassed = summary.humanDeadline !== null && summary.humanDeadline <= now;
  const lastNoticeToMe =
    mySeat !== null ? (events.findLast((e) => e.type === "system" && e.visibility === `seat:${mySeat}`) ?? null) : null;
  const timedOutSkipped =
    !ended &&
    lastNoticeToMe?.content.timeoutSkip === true &&
    !canSpeak &&
    !(phase === "SEARCH" && !iChoseLocation) &&
    !(phase === "VOTE" && (voteMode === "choice" ? summary.quiz !== null && !quizDone : !iVoted));

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

      <div className={`grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_310px] ${showLeftRail ? "xl:grid-cols-[250px_minmax(0,1fr)_310px]" : "xl:grid-cols-[minmax(0,1fr)_310px]"}`}>
      {/* 左栏：场景与行动（lg 两栏时横贯顶部，xl 起成为独立侧栏） */}
      {showLeftRail && <aside className="space-y-4 lg:col-span-2 xl:col-span-1">
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
                  {thinking[s.index] ? (
                    <span className="thinking-dots shrink-0 text-xs text-secret-400">思考中</span>
                  ) : summary.pendingAnswer?.toSeat === s.index ? (
                    <span className="shrink-0 text-[10px] text-danger-400">需作答</span>
                  ) : summary.turnSeat === s.index && (phase === "DISCUSSION" || phase === "SELF_INTRO") ? (
                    <span className="shrink-0 text-[10px] text-gold-400">发言中</span>
                  ) : null}
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
            {error && <p className="text-xs text-danger-400">{error}</p>}
            {deadlineLeft !== null && (
              <p className="rounded-lg border border-danger-400/40 bg-danger-400/10 px-3 py-2 text-xs font-medium text-danger-400">
                ⏱ 剩 {formatCountdown(deadlineLeft)}，超时将自动跳过
              </p>
            )}
            {deadlinePassed && deadlineLeft === null && !timedOutSkipped && (
              <p className="rounded-lg border border-danger-400/40 bg-danger-400/10 px-3 py-2 text-xs font-medium text-danger-400">
                ⏱ 时间已到，系统即将自动处理…
              </p>
            )}
            {timedOutSkipped && (
              <p className="rounded-lg border border-danger-400/40 bg-danger-400/10 px-3 py-2 text-xs font-medium text-danger-400">
                ⏱ {lastNoticeToMe?.content.text}
              </p>
            )}
            {phase === "READING" && (
              <button onClick={() => void send({ type: "ready" })} className="w-full rounded-lg bg-gold-500 py-2.5 text-sm font-semibold text-ink-950 hover:bg-gold-400">
                我已读完剧本
              </button>
            )}
            {phase === "SEARCH" && !iChoseLocation && (
              <div className="space-y-1.5">
                <p className="text-xs text-paper-400">{sending ? sendingLabel : "选择搜证地点："}</p>
                {summary.searchLocationOptions.filter((option) => option.status !== "own_room").map(({ name: loc, status, reason }) => {
                  const desc = summary.scriptV2?.locations.find((item) => item.name === loc)?.description?.find((block) => block.type === "paragraph")?.text;
                  const unavailable = status !== "available";
                  const statusText = unavailable && reason ? `（${reason}）` : "";
                  return (
                  <button
                    key={loc}
                    disabled={sending || unavailable}
                    onClick={() => void send({ type: "choose_location", location: loc })}
                    className="w-full rounded-lg border border-clue-400/20 bg-clue-400/5 px-3 py-2 text-left text-sm text-paper-200 transition hover:border-clue-400/60 hover:text-clue-400 disabled:opacity-50"
                  >
                    <span className="block">{loc}{statusText}</span>
                    {desc && <span className="mt-0.5 block text-xs leading-snug text-paper-500">{desc}</span>}
                  </button>
                  );
                })}
                {!summary.searchLocationOptions.some((option) => option.status === "available") && <p className="pt-1 text-xs text-paper-500">目前没有可搜的线索，系统会自动完成本轮搜证。</p>}
              </div>
            )}
            {phase === "SEARCH" && iChoseLocation && <p className="text-xs text-paper-400">已选择，等待其他玩家搜证…</p>}
            <VotePanel summary={summary} activeSeats={activeSeats} mySeat={mySeat} iVoted={iVoted} sending={sending} send={send} />
            {(summary.skills?.length ?? 0) > 0 && (phase === "SEARCH" || phase === "DISCUSSION") && (
              <div className="space-y-2 border-t border-gold-400/20 pt-3">
                <p className="text-xs text-gold-400">技能（剩余行动点 {summary.actionPointsLeft ?? 0}）：</p>
                {summary.skills.map((s) => {
                  const reason = s.phase !== phase ? "不在可用阶段" : s.cost > (summary.actionPointsLeft ?? 0) ? "行动点不足" : "已使用过";
                  return (
                    <div key={s.id} className="space-y-1.5">
                      <button
                        onClick={() => {
                          setSkillActiveId(skillActiveId === s.id ? null : s.id);
                          setSkillToSeat(null);
                        }}
                        disabled={!s.usable || sending}
                        title={s.usable ? s.description : `${s.description}（${reason}）`}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
                          skillActiveId === s.id ? "border-secret-400/60 bg-secret-400/10 text-secret-400" : "border-secret-400/20 text-paper-200 hover:border-secret-400/50"
                        }`}
                      >
                        【{s.name}】<span className="ml-1 text-xs text-paper-500">{s.cost} 点{s.once ? " · 单次" : ""}</span>
                      </button>
                      {skillActiveId === s.id && (
                        <div className="space-y-1.5 rounded-lg border border-secret-400/20 bg-ink-950/60 p-2">
                          <select
                            aria-label="选择技能目标座位"
                            value={skillToSeat ?? ""}
                            onChange={(e) => setSkillToSeat(Number(e.target.value))}
                            className="w-full rounded-lg border border-secret-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-secret-400"
                          >
                            <option value="" disabled>
                              选择质询对象（仅 AI）…
                            </option>
                            {activeSeats
                              .filter((s2) => s2.index !== mySeat && s2.kind === "ai")
                              .map((s2) => (
                                <option key={s2.index} value={s2.index}>
                                  {s2.characterName}
                                </option>
                              ))}
                          </select>
                          <div className="flex gap-2">
                            <input
                              aria-label="质询问题"
                              value={skillText}
                              onChange={(e) => setSkillText(e.target.value)}
                              maxLength={200}
                              placeholder="要对方正面回答的问题…"
                              className="min-w-0 flex-1 rounded-lg border border-secret-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-secret-400"
                            />
                            <button
                              onClick={() => {
                                if (skillToSeat !== null && skillText.trim()) {
                                  void send({ type: "use_skill", skillId: s.id, toSeat: skillToSeat, text: skillText });
                                  setSkillActiveId(null);
                                  setSkillToSeat(null);
                                  setSkillText("");
                                }
                              }}
                              disabled={sending || skillToSeat === null || !skillText.trim()}
                              className="rounded-lg bg-secret-400 px-3 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40"
                            >
                              质询
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {summary.pendingInteraction && <div className="space-y-2 rounded border border-gold-400/30 p-3"><p>{summary.pendingInteraction.prompt}</p>{summary.pendingInteraction.choices.map((choice) => <button key={choice.id} disabled={sending} className="mr-2 rounded bg-gold-500 px-3 py-2 text-ink-950" onClick={() => void send({ type: "interaction", beatId: summary.pendingInteraction!.id, choiceId: choice.id })}>{choice.label}</button>)}</div>}
            {phase === "DISCUSSION" && (
              <div className="space-y-2">
                {summary.pendingAnswer?.toSeat === mySeat ? (
                  <p className="text-xs text-danger-400">
                    {seatName(summary.pendingAnswer.fromSeat)} 问你：「{summary.pendingAnswer.question}」请在输入框当众回答，或拒绝作答。
                  </p>
                ) : summary.pendingAnswer?.fromSeat === mySeat ? (
                  <p className="text-xs text-paper-400">等待 {seatName(summary.pendingAnswer.toSeat)} 回答你的提问…</p>
                ) : summary.turnSeat === mySeat ? (
                  <>
                    <p className="text-xs text-paper-400">轮到你发言。可当众陈述，也可提问（剩余 {summary.questionsLeft} 次）。结束后请点「结束发言」。</p>
                    {summary.questionsLeft > 0 && (
                      <div className="space-y-2 border-t border-gold-400/20 pt-3">
                        <p className="text-xs text-gold-400">当众提问（全场讨论共 {summary.questionsLeft} 次）：</p>
                        <select
                          aria-label="选择提问对象"
                          value={activeSeats.some((seat) => seat.index === askTarget && seat.index !== mySeat) ? askTarget! : ""}
                          onChange={(e) => setAskTarget(e.target.value === "" ? null : Number(e.target.value))}
                          className="w-full rounded-lg border border-gold-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-gold-400"
                        >
                          <option value="" disabled>
                            选择提问对象…
                          </option>
                          {activeSeats
                            .filter((s) => s.index !== mySeat)
                            .map((s) => (
                              <option key={s.index} value={s.index}>
                                {s.characterName ?? s.playerName ?? `座位 ${s.index + 1}`}
                              </option>
                            ))}
                        </select>
                        <fieldset className="text-xs text-paper-300"><legend>引用公开证据（可选）</legend>{(summary.publicEvidence ?? []).map((clue) => <label key={clue.id} className="flex gap-2"><input type="checkbox" checked={askEvidence.includes(clue.id)} onChange={(event) => setAskEvidence((ids) => event.target.checked ? [...ids, clue.id] : ids.filter((id) => id !== clue.id))} />{clue.name}</label>)}</fieldset>
                        <div className="flex gap-2">
                          <input
                            aria-label="单独提问问题"
                            value={askText}
                            onChange={(e) => setAskText(e.target.value)}
                            placeholder="一个具体问题…"
                            className="min-w-0 flex-1 rounded-lg border border-gold-400/20 bg-ink-950 px-2 py-2 text-sm outline-none focus:border-gold-400"
                          />
                          <button
                            onClick={() => {
                              if (askTarget !== null && askText.trim()) {
                                void send({ type: "ask", toSeat: askTarget, text: askText, evidenceIds: askEvidence }).then((ok) => { if (ok) { setAskText(""); setAskEvidence([]); } });
                              }
                            }}
                            disabled={sending || askTarget === null || !askText.trim()}
                            className="rounded-lg bg-gold-500 px-3 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
                          >
                            提问
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-paper-400">
                    等待 {summary.turnSeat !== null ? seatName(summary.turnSeat) : "下一位"} 发言。不能插话。{summary.flow.allowPrivateChat ? "如收到私聊窗口，你仍可在窗口内回复。" : "本局讨论不开放私聊。"}
                  </p>
                )}
              </div>
            )}
            {phase === "SELF_INTRO" && summary.turnSeat === mySeat && (
              <button
                onClick={() => void send({ type: "skip" })}
                disabled={sending}
                className="w-full rounded-lg border border-paper-500/30 px-3 py-2 text-sm text-paper-300 hover:border-gold-400/50 hover:text-gold-400 disabled:opacity-40"
              >
                跳过本轮发言
              </button>
            )}
            {phase === "DISCUSSION" && summary.pendingAnswer?.toSeat === mySeat && (
              <button
                onClick={() => void send({ type: "skip" })}
                disabled={sending}
                className="w-full rounded-lg border border-danger-400/30 px-3 py-2 text-sm text-danger-400 hover:border-danger-400/60 disabled:opacity-40"
              >
                拒绝回答
              </button>
            )}
            {phase === "DISCUSSION" && summary.turnSeat === mySeat && !summary.pendingAnswer && (
              <button
                onClick={() => void send({ type: "skip" })}
                disabled={sending}
                className="w-full rounded-lg border border-paper-500/30 px-3 py-2 text-sm text-paper-300 hover:border-gold-400/50 hover:text-gold-400 disabled:opacity-40"
              >
                结束发言
              </button>
            )}
          </div>
        )}
        {/* 真人 DM 控制台 */}
        {isDm && !ended && <DmConsole dmData={dmData} error={error} onSend={(a) => void sendDm(a)} />}
        {!me && !isDm && !ended && (
          <p className="game-panel p-4 text-xs text-paper-500">
            {error && <span className="mb-1 block text-danger-400">{error}</span>}
            你正在以观众身份观看（公开事件流）。若你是本局玩家，回{" "}
            <Link href={`/rooms/${summary.roomCode}`} className="text-gold-400 hover:underline">
              房间 {summary.roomCode}
            </Link>{" "}
            用入座时的昵称认领座位。
          </p>
        )}
      </aside>}

      {/* 中栏：对话流 */}
      <ChatFeed
        summary={summary}
        events={events}
        mySeat={mySeat}
        seatName={seatName}
        aiSeatSet={aiSeatSet}
        ended={ended}
        reveal={reveal}
        deltas={deltas}
        dmThinking={dmThinking}
        dmDelta={dmDelta}
        showComposer={Boolean(me) && (phase === "SELF_INTRO" || phase === "DISCUSSION") && !ended}
        canSpeak={canSpeak}
        answering={answering}
        mySpeakTurn={mySpeakTurn}
        speakPlaceholder={speakPlaceholder}
        sending={sending}
        error={error}
        input={input}
        onInput={setInput}
        onSubmitSpeak={() => void submitSpeak()}
        onSpeakEvent={(seq) => void speakEvent(seq)}
        onSendWhisper={sendWhisper}
      />

      {/* 右栏：我的剧本 / 我的线索 / 时间线 */}
      <InfoRail
        summary={summary}
        events={events}
        me={me}
        mySeat={mySeat}
        isDm={isDm}
        dmData={dmData}
        ended={ended}
        activeSeats={activeSeats}
        sending={sending}
        send={send}
      />
      </div>
    </div>
  );
}
