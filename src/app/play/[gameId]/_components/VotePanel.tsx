"use client";

import { useState } from "react";
import type { GameSummary } from "@/lib/client";

/**
 * ★ 终局投票面板（批次 I3 自 play/[gameId]/page.tsx 拆出）★：
 * 指认真凶（culprit/hybrid 模式）+ 复盘答题卡（choice/hybrid 模式，整卷提交）。
 */
export function VotePanel({
  summary,
  activeSeats,
  mySeat,
  iVoted,
  sending,
  send,
}: {
  summary: GameSummary;
  activeSeats: Array<{ index: number; characterName: string | null }>;
  mySeat: number | null;
  iVoted: boolean;
  sending: boolean;
  send: (action: Record<string, unknown>) => Promise<boolean>;
}) {
  const [voteTarget, setVoteTarget] = useState<number | null>(null);
  const [voteReason, setVoteReason] = useState("");
  const [quizPicks, setQuizPicks] = useState<Record<string, string>>({});

  const voteMode = summary.voteMode ?? "culprit";
  const quizDone = summary.quiz !== null && summary.quiz.myAnswers !== null;
  const inVote = summary.phase === "VOTE";

  return (
    <>
      {inVote && !iVoted && voteMode !== "choice" && (
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
            aria-label="投票理由"
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
      {inVote && iVoted && voteMode !== "choice" && <p className="text-xs text-paper-400">已投票，等待其他人…</p>}
      {inVote && summary.quiz && !quizDone && (
        <div className="space-y-2">
          <p className="text-xs text-paper-400">复盘答题卡（整卷提交，交卷后不可修改）：</p>
          {summary.quiz.questions.map((q) => (
            <div key={q.id} className="rounded-lg border border-gold-400/15 bg-ink-950/50 p-2">
              <p className="text-xs text-paper-200">{q.prompt}</p>
              <div className="mt-1.5 space-y-1">
                {q.options.map((o) => (
                  <label key={o.id} className="flex cursor-pointer items-center gap-2 text-xs text-paper-300 hover:text-paper-100">
                    <input
                      type="radio"
                      name={`quiz-${q.id}`}
                      checked={quizPicks[q.id] === o.id}
                      onChange={() => setQuizPicks((p) => ({ ...p, [q.id]: o.id }))}
                      className="accent-gold-400"
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <button
            onClick={() => {
              if (!summary.quiz) return;
              const answers = summary.quiz.questions
                .map((q) => ({ questionId: q.id, optionId: quizPicks[q.id] }))
                .filter((a): a is { questionId: string; optionId: string } => Boolean(a.optionId));
              if (answers.length === summary.quiz.questions.length) void send({ type: "answer_quiz", answers });
            }}
            disabled={sending || !summary.quiz.questions.every((q) => quizPicks[q.id])}
            className="w-full rounded-lg bg-gold-500 py-2.5 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
          >
            交卷
          </button>
        </div>
      )}
      {inVote && summary.quiz && quizDone && <p className="text-xs text-paper-400">已交卷，等待其他人…</p>}
    </>
  );
}
