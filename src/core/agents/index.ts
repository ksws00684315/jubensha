import { chat, chatStream, extractJson } from "@/core/llm/client";
import type { Purpose } from "@/core/llm/types";
import { buildDmContext, buildPlayerContext, characterOf } from "./context";
import { buildSummarizeMessages } from "./memory";
import { createSpeechRedactor, dmGuardMarkers, guardDmSpeech, guardPlayerSpeech, playerGuardMarkers } from "./guard";
import { lastOwnSpeechText, shouldReviewSpeech } from "./review";
import { recallRelevantStatements } from "./recall";
import type { EngineEvent, GameState } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { clueText, locationNameOf } from "@/core/script/compat";
import { quizPrompt } from "@/core/engine/flow";
import type { QuizQuestionV2 } from "@/core/script/v2/schema";

export interface AgentCtx {
  script: ScriptDocV2;
  state: GameState;
  events: EngineEvent[];
  gameId: string;
}

/** 座位对应的 LLM 用途：凶手用 culprit 槽位（强模型），其余用 player 槽位 */
export function seatPurpose(script: ScriptDocV2, state: GameState, seatIndex: number): Purpose {
  const character = characterOf(script, state, seatIndex);
  return character?.privateCard.isCulprit ? "culprit" : "player";
}

/**
 * ★ 向量检索注入 ★：用最近几条发言作 query，把被滚动摘要压缩掉的相关旧发言找回来。
 * 只在已有摘要锚点时才有意义（否则全量日志已在上下文里）；失败/未绑定 embedding 时静默为空。
 */
async function recallFor(ctx: AgentCtx, seatIndex: number | null): Promise<string> {
  try {
    const anchorSeq = ctx.state.memory?.anchorSeq;
    if (!anchorSeq) return "";
    const recent = ctx.events
      .slice(-4)
      .filter((e) => e.type === "speech")
      .map((e) => String(e.content.text ?? ""))
      .join("\n");
    if (!recent.trim()) return "";
    const lines = await recallRelevantStatements({
      gameId: ctx.gameId,
      events: ctx.events,
      seatIndex,
      anchorSeq,
      query: recent,
    });
    if (!lines.length) return "";
    return `【旧事重提·与当前话题相关（帮你对照前后说法）】\n${lines.map((l) => `· ${l.label}：${l.text}`).join("\n")}`;
  } catch {
    return "";
  }
}

export const agent = {
  /** DM 开场白 / 转场旁白 */
  async dmNarrate(ctx: AgentCtx, task: string): Promise<string> {
    const messages = buildDmContext(ctx.script, ctx.state, ctx.events, { task, recall: await recallFor(ctx, null) });
    const res = await chat({
      purpose: "dm",
      gameId: ctx.gameId,
      messages,
      temperature: 0.7,
    });
    return guardDmSpeech(ctx.script, ctx.state, res.text).text;
  },

  /** DM 旁白（真流式）：句子级增量守卫，泄露句不会被放出。 */
  async *streamDmNarrate(ctx: AgentCtx, task: string): AsyncGenerator<string> {
    const messages = buildDmContext(ctx.script, ctx.state, ctx.events, { task, recall: await recallFor(ctx, null) });
    const redactor = createSpeechRedactor(dmGuardMarkers(ctx.script, ctx.state));
    for await (const chunk of chatStream({ purpose: "dm", gameId: ctx.gameId, messages, temperature: 0.7 })) {
      const delta = redactor.push(chunk);
      if (delta) yield delta;
    }
    const { delta } = redactor.flush();
    if (delta) yield delta;
  },

  /** 滚动记忆：把（旧摘要 + 新增公共记录）合并成一份概要。失败返回空串（调用方保留旧摘要）。 */
  async summarizeHistory(ctx: AgentCtx, prevSummary: string, headLog: string): Promise<string> {
    try {
      const res = await chat({
        purpose: "player",
        gameId: ctx.gameId,
        messages: buildSummarizeMessages(prevSummary, headLog),
        temperature: 0.2,
        maxTokens: 2048,
      });
      return res.text.trim().slice(0, 2000);
    } catch {
      return "";
    }
  },

  /** DM 评估人类发言后哪些 AI 接话 */
  async dmModerate(ctx: AgentCtx, humanSeat: number): Promise<{ respond: number[]; hint: string }> {
    const seats = ctx.state.seats.filter((s) => s.kind === "ai" && s.index !== humanSeat);
    if (!seats.length) return { respond: [], hint: "" };
    const requireJson = `一位玩家刚发言。请只根据公开记录决定哪些 AI 接话。请只输出 JSON：{"respond":[座位号...]}。respond 从这些座位里挑 0-2 个（被点名/被质疑/刚被问到的人）：${seats
      .map((s) => `${s.index + 1}`)
      .join("、")}。不要因为「谁更像真凶」来挑人。没有合适人选就输出空数组。`;
    const res = await chat({
      purpose: "dm",
      gameId: ctx.gameId,
      messages: buildDmContext(ctx.script, ctx.state, ctx.events, {
        task: "评估公开讨论并决定 AI 接话人选。不要暗示谁是真凶。",
        requireJson,
      }),
      temperature: 0.3,
    });
    const parsed = extractJson<{ respond?: number[] }>(res.text);
    const valid = new Set(seats.map((s) => s.index));
    return {
      respond: (parsed?.respond ?? []).map((n) => n - 1).filter((n) => valid.has(n)).slice(0, 2),
      hint: "",
    };
  },

  /** 玩家自我介绍 / 发言（带泄密守卫与一次重试） */
  async playerSpeak(ctx: AgentCtx, seatIndex: number, opts: { intro?: boolean; hint?: string; recall?: string } = {}): Promise<string> {
    const build = () =>
      buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, {
        hint: opts.hint,
        extraInstruction: opts.intro ? "这是你的自我介绍环节。" : undefined,
        recall: opts.recall,
      });
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    let guarded = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, (await chat({ purpose, gameId: ctx.gameId, messages: build(), temperature: 0.85 })).text);
    if (guarded.leaked.length) {
      const retry = await chat({ purpose, gameId: ctx.gameId, messages: build(), temperature: 0.85 });
      const guarded2 = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, retry.text);
      if (guarded2.text.length >= Math.min(20, guarded.text.length)) guarded = guarded2;
    }
    return guarded.text;
  },

  /** 玩家发言（真流式）：句子级增量守卫，泄露句不会被放出（替代先全文守卫再打字机的旧方案）。 */
  async *streamPlayerSpeech(
    ctx: AgentCtx,
    seatIndex: number,
    opts: { intro?: boolean; hint?: string; extraInstruction?: string; recall?: string } = {}
  ): AsyncGenerator<string> {
    const messages = buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, {
      hint: opts.hint,
      extraInstruction: opts.intro ? "这是你的自我介绍环节。" : opts.extraInstruction,
      recall: opts.recall ?? (await recallFor(ctx, seatIndex)),
    });
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    const redactor = createSpeechRedactor(playerGuardMarkers(ctx.script, ctx.state, seatIndex));
    for await (const chunk of chatStream({ purpose, gameId: ctx.gameId, messages, temperature: 0.85 })) {
      const delta = redactor.push(chunk);
      if (delta) yield delta;
    }
    const { delta } = redactor.flush();
    if (delta) yield delta;
  },

  /**
   * ★ 二次审查 ★（critique→refine）：启发式怀疑出戏/复读时，用一次廉价调用判定并最小修改。
   * 通过守卫的台词通常直接返回原文本（零额外成本）；审查失败时保留原文。
   */
  async refineSpeech(ctx: AgentCtx, seatIndex: number, text: string): Promise<string> {
    const ownLast = lastOwnSpeechText(ctx.events, seatIndex);
    if (!shouldReviewSpeech(text, ownLast)) return text;
    try {
      const res = await chat({
        purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
        gameId: ctx.gameId,
        temperature: 0.1,
        maxTokens: 1024,
        messages: [
          {
            role: "system",
            content:
              "你是剧本杀台词审查员。检查给定台词是否违规：1) 出戏（出现 AI/助手/游戏机制/系统提示等元话语，或舞台指示）；2) 与该角色上一段发言几乎重复。只做最小修改、保持角色口吻与原意。只输出 JSON：{\"ok\":true} 或 {\"ok\":false,\"text\":\"修改后的台词\"}。",
          },
          {
            role: "user",
            content: `【台词】\n${text}\n${ownLast ? `\n【该角色上一段发言】\n${ownLast}` : ""}`,
          },
        ],
      });
      const parsed = extractJson<{ ok?: boolean; text?: string }>(res.text);
      if (parsed && parsed.ok === false && typeof parsed.text === "string") {
        const refined = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, parsed.text.trim());
        if (refined.text.length >= Math.min(20, text.length)) return refined.text;
      }
    } catch {
      /* 审查失败就用原文 */
    }
    return text;
  },

  /**
   * ★ AI 主动私聊 ★：讨论轮发言结束后，AI 可审慎决定是否悄悄私信一位真人玩家。
   * 私信内容同样过泄密守卫；无明确动机时返回 null。
   */
  async playerConsiderWhisper(ctx: AgentCtx, seatIndex: number, humanSeats: number[]): Promise<{ toSeat: number; text: string } | null> {
    if (!humanSeats.length) return null;
    const roster = humanSeats
      .map((i) => {
        const seat = ctx.state.seats[i];
        const name = ctx.script.characters.find((c) => c.id === seat?.characterId)?.name ?? seat?.playerName ?? `座位${i + 1}`;
        return `${i + 1}:${name}`;
      })
      .join("、");
    const requireJson = `你有一个私密窗口的机会：可以悄悄私信一位真人玩家，其他玩家看不到这段对话。只在有明确动机时才发（交换情报/试探口风/私下结盟/旁敲侧击的警告），没有就不要发。请只输出 JSON：{"whisper":false} 或 {"whisper":true,"to":座位号,"text":"私信内容，40-120字，符合你的口吻与目的"}。可找：${roster}。私信里可以拿出你愿意交换的情报，但绝不能写出你的秘密原文，也不要替别人传话。`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson }),
      temperature: 0.5,
    });
    const parsed = extractJson<{ whisper?: boolean; to?: number; text?: string }>(res.text);
    if (!parsed?.whisper || parsed.to === undefined) return null;
    const toSeat = parsed.to - 1;
    const text = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, (parsed.text ?? "").trim()).text;
    if (!humanSeats.includes(toSeat) || !text) return null;
    return { toSeat, text: text.slice(0, 300) };
  },

  /** ★ 推荐回复 ★：轮到真人发言时，后台生成 3 条可直接说出口的短句（同样过守卫）。 */
  async suggestReplies(ctx: AgentCtx, seatIndex: number): Promise<string[]> {
    const requireJson = `请结合当前局面与你的处境，给出 3 条你现在可以直接说出口的短句，帮助玩家快速接话。要求：每条不超过 40 字，中文口语，符合你的人设、秘密与目标；可以是陈述、反问或试探；不要舞台指示，不要复读别人刚说过的话。请只输出 JSON：{"suggestions":["...","...","..."]}`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson }),
      temperature: 0.9,
    });
    const parsed = extractJson<{ suggestions?: unknown }>(res.text);
    if (!Array.isArray(parsed?.suggestions)) return [];
    const guard = (s: unknown): string | null => {
      if (typeof s !== "string") return null;
      const text = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, s.trim().slice(0, 60)).text;
      return text || null;
    };
    return parsed.suggestions.map(guard).filter((s): s is string => s !== null).slice(0, 3);
  },

  /** 玩家选择搜证地点 */
  async playerChooseLocation(ctx: AgentCtx, seatIndex: number, locations: string[]): Promise<string> {
    const character = characterOf(ctx.script, ctx.state, seatIndex);
    const asCulprit = character?.privateCard.isCulprit
      ? "若某地可能藏着对你不利的证据，优先去拿走它。"
      : "按你自己的目标和已知情报选择，不必像侦探一样搜遍所有关键地点。";
    const requireJson = `请只输出 JSON：{"location":"你选择的地点"}。候选地点：${locations.join("、")}。${asCulprit}`;
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    for (let i = 0; i < 3; i++) {
      const res = await chat({ purpose, gameId: ctx.gameId, messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson }), temperature: 0.6 });
      const parsed = extractJson<{ location?: string }>(res.text);
      if (parsed?.location && locations.includes(parsed.location)) return parsed.location;
    }
    return locations[Math.floor(Math.random() * locations.length)];
  },

  /** 玩家决定线索公开还是私藏 */
  async playerChoosePublish(ctx: AgentCtx, seatIndex: number, clueId: string): Promise<boolean> {
    const clue = ctx.script.clues.find((c) => c.id === clueId);
    if (!clue) return false;
    const requireJson = `你刚搜到线索卡【${clue.name}】（地点：${locationNameOf(ctx.script, clue.locationId)}）。内容：${clueText(clue)}。请只输出 JSON：{"publish":true/false}。publish=true 表示当场公开给大家，false 表示私藏。判断依据：公开对你有利/能推进调查就公开；线索指向你自己或暴露你的秘密就私藏。`;
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    for (let i = 0; i < 3; i++) {
      const res = await chat({ purpose, gameId: ctx.gameId, messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson }), temperature: 0.5 });
      const parsed = extractJson<{ publish?: boolean }>(res.text);
      if (typeof parsed?.publish === "boolean") return parsed.publish;
    }
    return false;
  },

  /** 讨论阶段：决定是否当众提问。无必要则返回 null。 */
  async playerConsiderQuestion(
    ctx: AgentCtx,
    seatIndex: number,
    candidates: number[],
  ): Promise<{ toSeat: number; question: string } | null> {
    if (!candidates.length) return null;
    const roster = candidates
      .map((i) => {
        const seat = ctx.state.seats[i];
        const name = ctx.script.characters.find((c) => c.id === seat?.characterId)?.name ?? seat?.playerName ?? `座位${i + 1}`;
        return `${i + 1}:${name}`;
      })
      .join("、");
    const requireJson = `现在轮到你发言。若有一个具体疑点需要对方当众回答，可提问一次；没有必要就不要问。请只输出 JSON：{"ask":false} 或 {"ask":true,"target":座位号,"question":"一个具体问题"}。可问：${roster}。不要一次抛多个问题，也不要审问式连问。`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson }),
      temperature: 0.5,
    });
    const parsed = extractJson<{ ask?: boolean; target?: number; question?: string }>(res.text);
    if (!parsed?.ask || parsed.target === undefined) return null;
    const toSeat = parsed.target - 1;
    const question = (parsed.question ?? "").trim();
    if (!candidates.includes(toSeat) || !question) return null;
    return { toSeat, question: question.slice(0, 200) };
  },

  /** 复盘答题：根据情报与推理作答（问题id→选项id；非法/缺题由引擎随机兜底） */
  async quizAnswer(ctx: AgentCtx, seatIndex: number, questions: ReadonlyArray<QuizQuestionV2>): Promise<Record<string, string>> {
    if (!questions.length) return {};
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson: quizPrompt(questions) }),
      temperature: 0.4,
    });
    const parsed = extractJson<{ answers?: Array<{ questionId?: string; optionId?: string }> }>(res.text);
    const out: Record<string, string> = {};
    for (const a of parsed?.answers ?? []) {
      if (typeof a?.questionId === "string" && typeof a?.optionId === "string") out[a.questionId] = a.optionId;
    }
    return out;
  },

  /** 玩家投票 */
  async playerVote(ctx: AgentCtx, seatIndex: number, candidates: number[]): Promise<{ target: number; reason: string }> {
    const character = characterOf(ctx.script, ctx.state, seatIndex);
    const asCulprit = character?.privateCard.isCulprit;
    const requireJson = asCulprit
      ? `请只输出 JSON：{"target":座位号,"reason":"一句话理由"}。可投座位：${candidates.map((n) => n + 1).join("、")}（不能投自己）。把票投给一个能让你脱身的人，理由必须听起来像基于公开讨论。`
      : `请只输出 JSON：{"target":座位号,"reason":"一句话理由"}。可投座位：${candidates.map((n) => n + 1).join("、")}（不能投自己）。你不是全知侦探：只根据公开发言和已公开线索投票，不要把只有你知道的私密情报当成全场共识。证据并不充分时，投疑点较大的人即可，不要表现得像已经知道答案。`;
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    for (let i = 0; i < 3; i++) {
      const res = await chat({ purpose, gameId: ctx.gameId, messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, { requireJson }), temperature: 0.4 });
      const parsed = extractJson<{ target?: number; reason?: string }>(res.text);
      if (parsed?.target !== undefined) {
        const t = parsed.target - 1;
        if (candidates.includes(t) && t !== seatIndex) {
          return { target: t, reason: (parsed.reason ?? "").slice(0, 120) };
        }
      }
    }
    const fallback = candidates.filter((c) => c !== seatIndex);
    return { target: fallback[Math.floor(Math.random() * fallback.length)], reason: "" };
  },

  /** 私聊回复 */
  async privateReply(ctx: AgentCtx, seatIndex: number, fromSeat: number, message: string): Promise<string> {
    const other = ctx.state.seats[fromSeat]?.playerName ?? `玩家${fromSeat + 1}`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      messages: buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, {
        hint: `私聊窗口：${other} 悄悄对你说：「${message}」。请以私聊口吻回复（可交换情报、试探、结盟或敷衍），40-120 字。`,
      }),
      temperature: 0.8,
    });
    return guardPlayerSpeech(ctx.script, ctx.state, seatIndex, res.text).text;
  },
};
