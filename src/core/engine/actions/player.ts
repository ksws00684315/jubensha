import { randomUUID } from "node:crypto";
import { clueText, resolveLocation } from "@/core/script/compat";
import { activeSeats } from "../state";
import { validateTransfer, validateUseSkill } from "../flow";
import { clearSuggestions, maybeQueueInterjection, queueAiPrivateReply } from "../social";
import { clearHumanTimeout } from "../human-turn";
import { applyPublish, availableLocations, cluesAt, NO_SEARCH_CHOICE, seatCharacterId, skillOf, syncSeatClueIds } from "../search-deal";
import { recordVote } from "../finale";
import { submitQuestion } from "../discussion";
import { validateVoteEvidence } from "../evidence";
import { chooseInteraction } from "../interactions";
import type { GameEngine } from "../engine";

export interface GameAction {
  type: "ready" | "speak" | "skip" | "ask" | "choose_location" | "publish" | "vote" | "private_chat" | "rush" | "transfer" | "use_skill" | "answer_quiz" | "interaction";
  beatId?: string;
  choiceId?: string;
  text?: string;
  location?: string;
  clueId?: string;
  skillId?: string;
  publish?: boolean;
  target?: number;
  reason?: string;
  evidenceIds?: string[];
  toSeat?: number;
  answers?: Array<{ questionId: string; optionId: string }>;
}

type Result = { ok: boolean; error?: string };
type Handler = (e: GameEngine, seatIndex: number, action: GameAction) => Promise<Result>;

export const PLAYER_ACTIONS: Record<GameAction["type"], Handler> = {
  "interaction": async (e, seatIndex, action) => {
    return chooseInteraction(e, seatIndex, action.beatId ?? "", action.choiceId ?? "");
  },
  "ready": async (e, seatIndex) => {
    if (e.state.phase !== "READING") return { ok: false, error: "当前不在读本环节" };
    clearHumanTimeout(e, seatIndex);
    if (!e.state.readySeats.includes(seatIndex)) e.state.readySeats.push(seatIndex);
    await e.systemSay("你已确认读完剧本。", seatIndex);
    await e.persist();
    e.continueTick();
    return { ok: true };
  },
  "speak": async (e, seatIndex, action) => {
    const text = (action.text ?? "").trim().slice(0, 800);
    if (!text) return { ok: false, error: "发言不能为空" };
    if (e.state.phase === "SELF_INTRO") {
      if (e.state.turnSeat !== seatIndex) return { ok: false, error: "现在不是你的发言回合" };
      await e.recordEvent({
        type: "speech",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: seatIndex,
        toSeat: null,
        visibility: "public",
        content: { text, speakerName: e.speakerName(seatIndex) },
      });
      clearSuggestions(e, seatIndex);
      clearHumanTimeout(e, seatIndex);
      e.markSpoken(seatIndex);
      await e.nextTurnOrAdvance();
      return { ok: true };
    }
    if (e.state.phase === "DISCUSSION") {
      if (e.state.pendingAnswer?.toSeat === seatIndex) {
        await e.recordEvent({
          type: "speech",
          phase: e.state.phase,
          round: e.state.round,
          fromSeat: seatIndex,
          toSeat: e.state.pendingAnswer.fromSeat,
          visibility: "public",
          content: { text, speakerName: e.speakerName(seatIndex), answer: true, questionId: e.state.pendingAnswer.questionId },
        });
        clearHumanTimeout(e, seatIndex);
        e.state.pendingAnswer = null;
        await e.persist();
        return { ok: true };
      }
      if (e.state.turnSeat !== seatIndex) return { ok: false, error: "现在不是你的发言回合" };
      if (e.state.pendingAnswer) return { ok: false, error: "请先等待对方回答你的提问" };
      await e.recordEvent({
        type: "speech",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: seatIndex,
        toSeat: null,
        visibility: "public",
        content: { text, speakerName: e.speakerName(seatIndex) },
      });
      clearSuggestions(e, seatIndex);
      await e.persist();
      // 点名了某位 AI → 对方可以立即简短插话回应（不占回合）
      maybeQueueInterjection(e, seatIndex, text);
      return { ok: true };
    }
    return { ok: false, error: "当前不能自由发言" };
  },
  "ask": async (e, seatIndex, action) => {
    return submitQuestion(e, seatIndex, action.toSeat ?? -1, action.text ?? "", action.evidenceIds);
  },
  "skip": async (e, seatIndex) => {
    if (e.state.phase !== "SELF_INTRO" && e.state.phase !== "DISCUSSION") {
      return { ok: false, error: "当前没有可跳过的发言回合" };
    }
    if (e.state.phase === "DISCUSSION" && e.state.pendingAnswer) {
      if (e.state.pendingAnswer.toSeat === seatIndex) {
        clearHumanTimeout(e, seatIndex);
        await e.systemSay("（你拒绝回答这个问题。）");
        e.state.pendingAnswer = null;
        await e.persist();
        e.continueTick();
        return { ok: true };
      }
      return { ok: false, error: "请先等待对方回答" };
    }
    if (e.state.turnSeat !== seatIndex) return { ok: false, error: "现在还没轮到你发言" };
    clearHumanTimeout(e, seatIndex);
    clearSuggestions(e, seatIndex);
    e.markSpoken(seatIndex);
    await e.systemSay("（你结束了本轮发言。）", seatIndex);
    await e.nextTurnOrAdvance();
    return { ok: true };
  },
  "choose_location": async (e, seatIndex, action) => {
    if (e.state.phase !== "SEARCH") return { ok: false, error: "当前不在搜证环节" };
    const chosen = e.state.searchChoices[String(seatIndex)];
    if (chosen) {
      // 哨兵值代表"本轮已无可搜、系统自动跳过"，与玩家主动选过地点是两回事，文案必须可区分
      return { ok: false, error: chosen === NO_SEARCH_CHOICE ? "本轮已无可搜地点，系统已自动完成搜证，无需选择" : "本轮已经选过地点" };
    }
    const loc = resolveLocation(e.script, action.location ?? "");
    if (!loc) return { ok: false, error: "地点不合法" };
    if (loc.ownerCharacterId === seatCharacterId(e, seatIndex)) {
      return { ok: false, error: "你不能搜自己的房间" };
    }
    if (!availableLocations(e, seatIndex).includes(loc.name) || cluesAt(e, loc.name, seatIndex).length === 0) {
      return { ok: false, error: `「${loc.name}」的线索已搜完，请选择其他地点` };
    }
    e.state.searchChoices[String(seatIndex)] = loc.name;
    clearHumanTimeout(e, seatIndex);
    await e.systemSay(`你选择了「${loc.name}」搜证。`, seatIndex);
    await e.persist();
    e.continueTick();
    return { ok: true };
  },
  "publish": async (e, seatIndex, action) => {
    if (e.state.phase !== "SEARCH") return { ok: false, error: "当前不在搜证环节" };
    const clueId = action.clueId ?? "";
    const held = (e.state.heldClues[seatIndex] ?? []).includes(clueId);
    if (!held) return { ok: false, error: "你没有这张线索卡" };
    const pending = e.state.pendingPublish[String(seatIndex)] ?? [];
    if (!pending.includes(clueId)) return { ok: false, error: "当前不能公开或私藏这张卡" };
    const clue = e.script.clues.find((c) => c.id === clueId);
    if (clue?.policy === "keep_private" && action.publish) return { ok: false, error: "该线索必须私藏" };
    await applyPublish(e, seatIndex, clueId, action.publish ?? false);
    e.state.pendingPublish[String(seatIndex)] = pending.filter((id) => id !== clueId);
    if (e.state.pendingPublish[String(seatIndex)]?.length === 0) e.clearTimers(`pub:${seatIndex}`);
    await e.persist();
    e.continueTick();
    return { ok: true };
  },
  "vote": async (e, seatIndex, action) => {
    if (e.state.phase !== "VOTE") return { ok: false, error: "当前不在投票环节" };
    if (e.script.flow.voteMode === "choice") return { ok: false, error: "本局为复盘答题模式，无需投票" };
    if (e.state.votes[String(seatIndex)]) return { ok: false, error: "本轮已经投过票" };
    const target = action.target;
    if (target === undefined || !activeSeats(e.state).includes(target)) return { ok: false, error: "投票对象不合法" };
    if (target === seatIndex) return { ok: false, error: "不能投自己" };
    const evidenceError = validateVoteEvidence(e.script.clues, e.state.clueStates, action.evidenceIds);
    if (evidenceError) return { ok: false, error: evidenceError };
    // 真人理由超限给出明确拒绝而非静默腰斩；AI 长输出由 recordVote 统一节选标注（T1.2）
    const rawReason = action.reason ?? "";
    if (e.state.seats[seatIndex]?.kind !== "ai" && rawReason.length > 200) {
      return { ok: false, error: "投票理由请控制在 200 字内" };
    }
    await recordVote(e, seatIndex, target, rawReason || undefined, action.evidenceIds);
    clearHumanTimeout(e, seatIndex);
    // hybrid：投票后可能还差答题，允许 step 重新武装剩余限时
    e.turnAsked.delete(`ask:VOTE:${seatIndex}`);
    e.continueTick();
    return { ok: true };
  },
  "answer_quiz": async (e, seatIndex, action) => {
    // ★ 复盘答题 ★：choice/hybrid 模式整卷一次性提交，提交后锁定。
    if (e.state.phase !== "VOTE") return { ok: false, error: "当前不在投票/复盘环节" };
    if (e.script.flow.voteMode === "culprit") return { ok: false, error: "本局没有复盘答题" };
    const questions = e.script.ending.quiz;
    if (!questions.length) return { ok: false, error: "本局没有复盘答题" };
    if (e.state.quizAnswers?.[String(seatIndex)]) return { ok: false, error: "已作答，不能修改" };
    const answers = Array.isArray(action.answers) ? action.answers : [];
    const sheet: Record<string, string> = {};
    for (const a of answers) {
      const q = questions.find((qq) => qq.id === a?.questionId);
      if (!q) return { ok: false, error: `题目不存在：${a?.questionId ?? "?"}` };
      if (!q.options.some((o) => o.id === a.optionId)) return { ok: false, error: `选项不合法：${a.optionId ?? "?"}` };
      sheet[q.id] = a.optionId;
    }
    if (Object.keys(sheet).length !== questions.length) return { ok: false, error: "请答完全部题目后再整卷提交" };
    e.state.quizAnswers ??= {};
    e.state.quizAnswers[String(seatIndex)] = sheet;
    clearHumanTimeout(e, seatIndex);
    // hybrid：交卷后可能还差投票，允许 step 按剩余项重新武装
    e.turnAsked.delete(`ask:VOTE:${seatIndex}`);
    await e.systemSay("（你已提交复盘答题卡，等待其他人作答。）", seatIndex);
    await e.persist();
    e.continueTick();
    return { ok: true };
  },
  "use_skill": async (e, seatIndex, action) => {
    // ★ 技能卡·质询（verify）★：消耗行动点，强制目标 AI 当众正面回答。
    const skillId = action.skillId ?? "";
    const toSeat = action.toSeat;
    const text = (action.text ?? "").trim().slice(0, 200);
    const invalid = validateUseSkill(e.script, e.state, seatIndex, skillId, toSeat, text);
    if (invalid) return { ok: false, error: invalid };
    const skill = skillOf(e, seatIndex, skillId);
    if (!skill || toSeat === undefined) return { ok: false, error: "技能不可用" };
    e.state.actionPoints ??= {};
    e.state.actionPoints[String(seatIndex)] = (e.state.actionPoints[String(seatIndex)] ?? 0) - skill.cost;
    e.state.usedSkills ??= [];
    if (skill.once) e.state.usedSkills.push(`${seatIndex}:${skill.id}`);
    e.state.pendingAnswer = { questionId: randomUUID(), fromSeat: seatIndex, toSeat, question: text, forced: true };
    // 技能提问与普通提问一样，暂停提问者的回合超时；作答完成后由讨论推进重新武装。
    clearHumanTimeout(e, seatIndex);
    await e.recordEvent({
      type: "system",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: null,
      toSeat: null,
      visibility: "public",
      content: {
        text: `${e.speakerName(seatIndex)} 动用了技能【${skill.name}】，要求 ${e.speakerName(toSeat)} 当众正面回答：${text}`,
        skillId,
        questionId: e.state.pendingAnswer.questionId,
      },
    });
    await e.persist();
    return { ok: true };
  },
  "transfer": async (e, seatIndex, action) => {
    // ★ 线索转交 ★：讨论阶段把未公开的持有线索私下面交给其他座位，双方可见。
    const toSeat = action.toSeat;
    const clueId = action.clueId ?? "";
    if (toSeat === undefined) return { ok: false, error: "转交对象不合法" };
    const invalid = validateTransfer(e.script, e.state, seatIndex, clueId, toSeat);
    if (invalid) return { ok: false, error: invalid };
    const clue = e.script.clues.find((c) => c.id === clueId);
    if (!clue) return { ok: false, error: "你没有这张线索卡" };
    e.state.heldClues[seatIndex] = (e.state.heldClues[seatIndex] ?? []).filter((id) => id !== clueId);
    e.state.heldClues[toSeat] = [...(e.state.heldClues[toSeat] ?? []), clueId];
    await e.recordEvent({
      type: "transfer",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: seatIndex,
      toSeat,
      visibility: `seat:${toSeat}`,
      content: {
        clueId,
        clueName: clue.name,
        clueContent: clueText(clue),
        text: `${e.speakerName(seatIndex)} 悄悄把一张线索卡交给了你。`,
      },
    });
    await syncSeatClueIds(e, seatIndex);
    await syncSeatClueIds(e, toSeat);
    await e.persist();
    return { ok: true };
  },
  "private_chat": async (e, seatIndex, action) => {
    // ★ AI 主动私信的回复通道 ★：只有当某位 AI 向你开过私信窗口时才能回复。
    if (!e.script.flow.allowPrivateChat) return { ok: false, error: "本局未开放私聊" };
    if (e.state.phase !== "DISCUSSION") return { ok: false, error: "当前不在讨论环节" };
    const toSeat = action.toSeat ?? -1;
    const target = e.state.seats[toSeat];
    if (!target || toSeat === seatIndex) return { ok: false, error: "私信对象不合法" };
    const text = (action.text ?? "").trim().slice(0, 300);
    if (!text) return { ok: false, error: "回复不能为空" };
    if (target.kind === "ai") {
      // ★ AI 主动私信的回复通道 ★：只有当某位 AI 向你开过私信窗口时才能回复。
      const key = `${toSeat}-${seatIndex}`;
      if ((e.state.privateChat[key] ?? 0) <= 0) return { ok: false, error: "对方没有向你发起私信" };
      // 消耗一次窗口额度（非一次性封口）：AI 再次私信可续，额度用尽即封口。
      e.state.privateChat[key] -= 1;
      await e.recordEvent({
        type: "private",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: seatIndex,
        toSeat,
        visibility: `seat:${toSeat}`,
        content: { text },
      });
      await e.persist();
      queueAiPrivateReply(e, toSeat, seatIndex, text);
      return { ok: true };
    }
    // ★ 真人→真人主动私信（T2.1）★：纯真人局唯一的私聊通道；每个方向独立限
    // privateChatMessageLimit 条，已用数记在 `h${发起方}-${接收方}`（h 前缀与 AI 窗口的
    // 剩余额度语义隔离，避免被 seat view 的 openWhispers 误渲染成可回复窗口）。
    const ownKey = `h${seatIndex}-${toSeat}`;
    const used = e.state.privateChat[ownKey] ?? 0;
    const limit = e.script.flow.privateChatMessageLimit;
    if (used >= limit) return { ok: false, error: `对这位玩家的私信额度已用完（每个方向 ${limit} 条）` };
    e.state.privateChat[ownKey] = used + 1;
    await e.recordEvent({
      type: "private",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: seatIndex,
      toSeat,
      visibility: `seat:${toSeat}`,
      content: { text },
    });
    await e.persist();
    return { ok: true };
  },
  "rush": async (e) => {
    e.continueTick();
    return { ok: true };
  },
};

export async function handleUnknownPlayerAction(): Promise<Result> {
  return { ok: false, error: "未知动作" };
}
