import { agent } from "@/core/agents";
import { forcedAnswerHint, validateDiscussionAsk } from "./flow";
import { activeSeats } from "./state";
import { AI_DECISION_TIMEOUT_MS, withTimeout } from "./util";
import { dispatchAnswerTurn, dispatchPlayerSpeech } from "./turns";
import { armHumanTimeout, clearHumanTimeout } from "./human-turn";
import { maybeQueueWhisper } from "./social";
import type { GameEngine } from "./engine";

/**
 * ★ 讨论域（批次 I1 自 engine.ts 拆出）★：当众提问/作答链路 + AI 讨论回合。
 */

function legalPublicEvidenceIds(e: GameEngine, ids: readonly string[] | undefined): string[] {
  const publicIds = new Set(e.script.clues.filter((clue) => e.state.clueStates[clue.id]?.isPublic).map((clue) => clue.id));
  return [...new Set(ids ?? [])].filter((id) => publicIds.has(id));
}

function duplicateQuestion(e: GameEngine, fromSeat: number, toSeat: number, evidenceIds: readonly string[]): boolean {
  if (!evidenceIds.length) return false;
  const key = [...evidenceIds].sort().join(",");
  return e.events.some((event) =>
    event.type === "speech" &&
    event.phase === "DISCUSSION" &&
    event.round === e.state.round &&
    event.fromSeat === fromSeat &&
    event.toSeat === toSeat &&
    Array.isArray(event.content.evidenceIds) && [...event.content.evidenceIds as string[]].sort().join(",") === key,
  );
}

export async function submitQuestion(e: GameEngine, fromSeat: number, toSeat: number, question: string, evidenceIds?: string[]): Promise<{ ok: boolean; error?: string }> {
  const invalid = validateDiscussionAsk(e.state, fromSeat, toSeat);
  if (invalid) return { ok: false, error: invalid };
  const left = e.state.questionsLeft[String(fromSeat)] ?? 0;
  const text = question.trim().slice(0, 200);
  if (!text) return { ok: false, error: "问题不能为空" };
  const legalEvidenceIds = legalPublicEvidenceIds(e, evidenceIds);
  if (duplicateQuestion(e, fromSeat, toSeat, legalEvidenceIds)) return { ok: false, error: "本轮已围绕同一组证据问过这位玩家，请等待新线索" };
  e.state.questionsLeft[String(fromSeat)] = left - 1;
  e.state.pendingAnswer = { fromSeat, toSeat, question: text, ...(legalEvidenceIds.length ? { evidenceIds: legalEvidenceIds } : {}) };
  // 提问 = 证明在参与，暂停提问者超时；作答结束后 step() 会经 ensureHumanTimeout 重新武装
  clearHumanTimeout(e, fromSeat);
  await e.recordEvent({
    type: "speech",
    phase: e.state.phase,
    round: e.state.round,
    fromSeat,
    toSeat,
    visibility: "public",
    content: { text: `我问${e.speakerName(toSeat)}：${text}`, speakerName: e.speakerName(fromSeat), ...(legalEvidenceIds.length ? { evidenceIds: legalEvidenceIds } : {}) },
  });
  await e.persist();
  return { ok: true };
}

export async function resolvePendingAnswer(e: GameEngine): Promise<void> {
  const pending = e.state.pendingAnswer;
  if (!pending) return;
  const target = pending.toSeat;
  if (e.state.seats[target]?.kind === "ai") {
    if (e.turnInFlight) return; // 回答回合在飞
    const base = `${e.speakerName(pending.fromSeat)} 当众问你：「${pending.question}」。`;
    const hint = pending.forced
      ? forcedAnswerHint(base)
      : `${base}请正面回答这个问题；可以藏秘密，但不能装作没听见。`;
    dispatchAnswerTurn(e, target, hint, async () => {
      await e.tickInner();
    });
    return;
  }
  const askKey = `answer:${pending.fromSeat}:${target}:${e.state.round}`;
  if (!e.turnAsked.has(askKey)) {
    e.turnAsked.add(askKey);
    await armHumanTimeout(e, target, "回答提问", async () => {
      if (!e.state.pendingAnswer) return;
      await e.systemSay(`（${e.speakerName(target)} 没有回答，「${pending.question}」作废。）`);
      e.state.pendingAnswer = null;
      await e.persist();
      await e.tickInner();
    });
    await e.systemSay(`请当场回答「${e.speakerName(pending.fromSeat)}」的提问：${pending.question}`, target);
  }
}

export async function runAiDiscussionTurn(e: GameEngine, seat: number): Promise<void> {
  if (!e.aiDiscussionAsked.has(seat)) {
    e.aiDiscussionAsked.add(seat);
    const left = e.state.questionsLeft[String(seat)] ?? 0;
    if (left > 0) {
      try {
        const asked = await withTimeout(
          agent.playerConsiderQuestion(e.ctx(), seat, activeSeats(e.state).filter((i) => i !== seat)),
          AI_DECISION_TIMEOUT_MS,
        );
        if (asked) {
          const result = await submitQuestion(e, seat, asked.toSeat, asked.question, asked.evidenceIds);
          if (result.ok) {
            e.pendingTick = true;
            return;
          }
        }
      } catch {
        /* 不问，直接发言 */
      }
    }
  }
  if (e.turnInFlight) return; // 回合在飞,提交回调会续跑
  dispatchPlayerSpeech(
    e,
    seat,
    { hint: `现在轮到你当众发言。根据公开信息和你愿意拿出的情报做一段陈述，不要连珠炮质问，也不要替别人作答。` },
    async () => {
      e.markSpoken(seat);
      await e.nextTurnOrAdvance();
      maybeQueueWhisper(e, seat);
    }
  );
}
