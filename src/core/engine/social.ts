import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { agent } from "@/core/agents";
import { SUMMARY_MIN_INTERVAL_ROUNDS, SUMMARY_TRIGGER_CHARS, pendingHeadChars, planMemorySplit } from "@/core/agents/memory";
import { MAX_INTERJECTIONS_PER_ROUND, mentionedAiSeats } from "@/core/agents/mention";
import { embedTexts, embeddingSpaceId, resolveBinding } from "@/core/llm/client";
import { activeSeats, renderEventLog } from "./state";
import { publish } from "./bus";
import { AI_DECISION_TIMEOUT_MS, isNewerSeq, withTimeout } from "./util";
import { consumeStream } from "./turns";
import type { GameEngine } from "./engine";

/**
 * ★ 社交与记忆层（批次 I1 自 engine.ts 拆出）★：
 * mention 插话 / AI 主动私信 / 私信回复 / 推荐回复 / 向量写入 / 轮次边界摘要。
 * 全部是"锁外生成 → 短暂锁内提交"的后台任务，引擎实例以参数注入。
 */

/**
 * 向量检索记忆层·写入侧：公开发言异步向量化入库（批量防抖）。
 * 检索候选只取发言，其余事件不写入，省 embedding 开销。
 * 未绑定 embedding 槽位时 embedTexts 返回 null，整层静默关闭。
 */
export function queueEmbed(e: GameEngine, event: { seq: string; visibility: string; type: string; content: Record<string, unknown>; fromSeat: number | null }): void {
  if (event.visibility !== "public" || event.type !== "speech") return;
  const text = String(event.content.text ?? "");
  if (!text.trim()) return;
  e.embedQueue.push({ seq: event.seq, text: `${e.speakerName(event.fromSeat ?? 0)}说：${text}`.slice(0, 512) });
  // 同一 key 的定时器会被后面的 push 重置 → 一波密集发言只跑最后一次；
  // 因此这里必须把队列排空，否则超过 8 条的积压要等下一次新发言才可能被取出，对局结束时永久滞留。
  e.scheduleBackground("embed", async () => {
    while (e.embedQueue.length) {
      const batch = e.embedQueue.splice(0, 8);
      const vectors = await embedTexts(batch.map((b) => b.text));
      if (!vectors) {
        // embedding 未绑定或调用失败：整层静默降级，丢弃积压避免无界增长
        e.embedQueue.length = 0;
        return;
      }
      const binding = await resolveBinding("embedding").catch(() => null);
      const spaceId = binding ? embeddingSpaceId(binding) : "legacy";
      for (let i = 0; i < batch.length; i++) {
        await db.eventVector
          .upsert({
            where: { gameId_seq: { gameId: e.gameId, seq: BigInt(batch[i].seq) } },
            create: { gameId: e.gameId, seq: BigInt(batch[i].seq), vector: vectors[i], spaceId, dimension: vectors[i]?.length ?? 0, sourceHash: createHash("sha256").update(batch[i].text).digest("hex") },
            update: { vector: vectors[i], spaceId, dimension: vectors[i]?.length ?? 0, sourceHash: createHash("sha256").update(batch[i].text).digest("hex") },
          })
          .catch(() => null); // 重复写入等场景直接忽略
      }
    }
  }, 1500);
}

/**
 * mention 插话调度：真人发言点名了某位 AI，该 AI 立即简短回应。
 * 不占用任何人的正式发言回合、不改 turnSeat；每轮讨论限 MAX_INTERJECTIONS_PER_ROUND 次。
 * 流式在互斥锁外进行，结束时短暂排队补记事件；阶段已离开讨论则丢弃。
 */
export function maybeQueueInterjection(e: GameEngine, fromSeat: number, text: string): void {
  if (e.state.phase !== "DISCUSSION") return;
  if (e.state.interjections >= MAX_INTERJECTIONS_PER_ROUND) return;
  const target = mentionedAiSeats(e.script, e.state, text, fromSeat)[0];
  if (target === undefined) return;
  const round = e.state.round;
  const queuedAfter = e.events.at(-1)?.seq ?? "0";
  const cancelled = () => e.state.phase !== "DISCUSSION" || e.state.round !== round ||
    (e.state.pendingAnswer?.fromSeat === fromSeat && e.state.pendingAnswer.toSeat === target) ||
    e.events.some((ev) => ev.content.questionId && !ev.content.answer && ev.fromSeat === fromSeat && ev.toSeat === target && BigInt(ev.seq) > BigInt(queuedAfter));
  if (cancelled()) return;
  // key 带上双方座位：单一 key 会让同轮内的第二次点名取消并替换前一次的插话任务，
  // 名义上限是 3 次、实际每轮最多 1 次落地。上限仍由 interjections 计数守住。
  e.scheduleBackground(`interject:${fromSeat}:${target}`, async () => {
    if (cancelled() || e.state.interjections >= MAX_INTERJECTIONS_PER_ROUND) return;
    await e.exclusive(async () => {
      if (cancelled() || e.state.interjections >= MAX_INTERJECTIONS_PER_ROUND) return;
      e.state.interjections++;
      await e.persist();
    });
    if (cancelled()) return;
    const opts = {
      hint: `${e.speakerName(fromSeat)} 刚才点名提到了你：「${text.slice(0, 120)}」。请作为插话立即简短回应。`,
      extraInstruction:
        "这是一次插话（不占用你的正式发言回合）：一两句话（40-90字）自然接话，可以自证、反驳或带过；不要重复你之前说过的内容，不要替别人作答。",
    };
    let said = await consumeStream(
      (signal) => agent.streamPlayerSpeech(e.ctx(), target, { ...opts, abortSignal: signal }),
      (delta) => { if (!cancelled()) publish(e.gameId, { kind: "delta", seat: target, text: delta, audience: "public" }); },
      AI_DECISION_TIMEOUT_MS,
      new AbortController().signal
    );
    if (!said.trim()) {
      try {
        said = await withTimeout(agent.playerSpeak(e.ctx(), target, opts), AI_DECISION_TIMEOUT_MS);
      } catch {
        said = "";
      }
    }
    said = await agent.refineSpeech(e.ctx(), target, said);
    await e.exclusive(async () => {
      if (cancelled() || !said.trim()) return;
      await e.recordEvent({
        type: "speech",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: target,
        toSeat: fromSeat,
        visibility: "public",
        content: { text: said, speakerName: e.speakerName(target), interjection: true },
      });
    });
  }, 400);
}

/**
 * AI 主动私聊：AI 发言结束后可审慎决定悄悄私信一位真人玩家（每 AI 每轮一次）。
 * 私信事件 visibility 只给收件人；发送方凭 fromSeat 规则在自己上下文里看到自己说过的话。
 */
export function maybeQueueWhisper(e: GameEngine, seat: number): void {
  if (!e.script.flow.allowPrivateChat) return;
  if (e.state.phase !== "DISCUSSION") return;
  if (e.whisperAsked.has(seat)) return;
  e.whisperAsked.add(seat);
  const humanSeats = activeSeats(e.state).filter((i) => e.state.seats[i].kind === "human" && i !== seat);
  if (!humanSeats.length) return;
  e.scheduleBackground(`whisper:${seat}`, async () => {
    let decision: { toSeat: number; text: string } | null = null;
    try {
      decision = await withTimeout(agent.playerConsiderWhisper(e.ctx(), seat, humanSeats), AI_DECISION_TIMEOUT_MS);
    } catch {
      decision = null;
    }
    if (!decision) return;
    await e.exclusive(async () => {
      if (e.state.phase !== "DISCUSSION") return;
      if (e.state.seats[decision.toSeat]?.kind !== "human") return;
      const key = `${seat}-${decision.toSeat}`;
      // 私信窗口累计可回复次数，封顶 privateChatMessageLimit；真人每回复一次消耗一点。
      e.state.privateChat[key] = Math.min((e.state.privateChat[key] ?? 0) + 1, e.script.flow.privateChatMessageLimit);
      await e.recordEvent({
        type: "private",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: seat,
        toSeat: decision.toSeat,
        visibility: `seat:${decision.toSeat}`,
        content: { text: decision.text },
      });
      await e.persist();
    });
  }, 1200);
}

/** 真人回复 AI 私信后，AI 用原私聊口吻回一句（同样只双方可见）。 */
export function queueAiPrivateReply(e: GameEngine, aiSeat: number, humanSeat: number, message: string): void {
  e.scheduleBackground(`whisper-reply:${aiSeat}-${humanSeat}`, async () => {
    let reply = "";
    try {
      reply = await withTimeout(agent.privateReply(e.ctx(), aiSeat, humanSeat, message), AI_DECISION_TIMEOUT_MS);
    } catch {
      reply = "";
    }
    if (!reply.trim()) return;
    await e.exclusive(async () => {
      if (e.state.phase !== "DISCUSSION") return;
      await e.recordEvent({
        type: "private",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: aiSeat,
        toSeat: humanSeat,
        visibility: `seat:${humanSeat}`,
        content: { text: reply },
      });
    });
  }, 100);
}

/** 推荐回复：轮到真人发言时后台生成 3 条建议短句；发言/跳过后清除。 */
export function queueSuggestReply(e: GameEngine, seat: number): void {
  const key = `${e.state.phase}:${e.state.round}:${seat}`;
  if (e.suggestAsked.has(key)) return;
  e.suggestAsked.add(key);
  e.scheduleBackground(`suggest:${seat}`, async () => {
    let items: string[] = [];
    try {
      items = await withTimeout(agent.suggestReplies(e.ctx(), seat), AI_DECISION_TIMEOUT_MS);
    } catch {
      items = [];
    }
    if (!items.length) return;
    await e.exclusive(async () => {
      // 提交前确认"现在仍然是该座位的发言回合"：真人可能已经发言/跳过，
      // 甚至已经切到下一个阶段——不能把过期的建议写回状态（否则 UI 会重新冒出建议按钮）。
      if (e.state.phase !== "SELF_INTRO" && e.state.phase !== "DISCUSSION") return;
      if (e.state.turnSeat !== seat) return;
      if (e.state.spokenSeats.includes(seat)) return;
      if (!e.state.suggestions) e.state.suggestions = {};
      e.state.suggestions[String(seat)] = items;
      await e.persist();
    });
  }, 200);
}

export function clearSuggestions(e: GameEngine, seat: number): void {
  e.clearTimers(`suggest:${seat}`);
  if (e.state.suggestions) delete e.state.suggestions[String(seat)];
}

/**
 * 分层记忆维护：只在轮次边界（进入新搜证轮/讨论轮）滚动更新摘要。
 * 摘要文本位于 prompt 用户消息开头，局中更新会同时打掉全部座位+DM 的前缀缓存，
 * 因此刻意锚定在轮次边界——轮内前缀保持稳定，前缀缓存命中率随对局推进持续走高。
 * LLM 调用在互斥锁外，完成后只把短暂的状态提交重新排队（同 AI 投票决策模式）。
 */
export function maybeScheduleSummarize(e: GameEngine): void {
  if (e.state.phase === "REVEAL" || e.state.phase === "ENDED") return;
  // 降频门槛：摘要重写会把全场（含 DM）的前缀缓存整体打掉，而轮次边界恰好就是 DM 调用之前，
  // 所以限制「至少隔 SUMMARY_MIN_INTERVAL_ROUNDS 个边界才更新一次」，用略旧的摘要换一半的失效次数。
  e.summaryBoundaries++;
  if (e.summaryBoundaries - e.lastSummaryBoundary < SUMMARY_MIN_INTERVAL_ROUNDS) return;
  const pending = pendingHeadChars(e.events, e.state.memory?.anchorSeq ?? "");
  if (pending < SUMMARY_TRIGGER_CHARS) return;
  const boundary = { phase: e.state.phase, round: e.state.round };
  const boundaryIndex = e.summaryBoundaries;
  e.scheduleBackground("memory", async () => {
    if (e.state.phase !== boundary.phase || e.state.round !== boundary.round) return; // 已进入下一边界,留给下次
    const { head } = planMemorySplit(e.events);
    const anchor = head[head.length - 1];
    if (!anchor || !isNewerSeq(anchor.seq, e.state.memory?.anchorSeq)) return;
    // 只把上个锚点之后的「新增」记录交给摘要员（旧摘要已由 buildSummarizeMessages 携带），避免重复发送整段历史
    const prevAnchorSeq = e.state.memory?.anchorSeq ?? "";
    const splitAt = prevAnchorSeq ? head.findIndex((ev) => ev.seq === prevAnchorSeq) + 1 : 0;
    const pendingLog = renderEventLog(head.slice(splitAt), null);
    if (!pendingLog.trim()) return;
    const summary = await agent.summarizeHistory(e.ctx(), e.state.memory?.summary ?? "", pendingLog);
    if (!summary) return; // 摘要失败保留旧记忆，下次边界再试
    await e.exclusive(async () => {
      // 提交前仍在同一轮次边界内：不把缓存失效带进轮中
      if (e.state.phase !== boundary.phase || e.state.round !== boundary.round) return;
      if (!isNewerSeq(anchor.seq, e.state.memory?.anchorSeq)) return;
      e.state.memory = { anchorSeq: anchor.seq, summary };
      e.lastSummaryBoundary = boundaryIndex;
      await e.persist();
    });
  }, 100);
}
