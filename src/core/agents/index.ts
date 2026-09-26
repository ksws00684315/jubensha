import { bigramSimilarity } from "@/core/engine/questions";
import { chat, chatStream, extractJson, ROLE_ANCHOR } from "@/core/llm/client";
import { isRefusalBoilerplate, isSafetyRefusal } from "@/core/llm/output-tokens";
import type { Purpose } from "@/core/llm/types";
import { buildDmContext, buildPlayerContext, characterOf } from "./context";
import { buildSummarizeMessages } from "./memory";
import { createSpeechRedactor, dmGuardMarkers, guardDmSpeech, guardPlayerSpeech, playerGuardMarkers } from "./guard";
import { degradedSpeechLine, lastOwnSpeechText, makeNoveltyJudge, shouldReviewSpeech } from "./review";
import { recallRelevantStatements } from "./recall";
import type { EngineEvent, GameState, PlayerActionPlan } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { clueText, locationNameOf, narrativeToText, timelineToText } from "@/core/script/compat";
import { rewriteAppropriatedWitness } from "./witness";
import { quizPrompt } from "@/core/engine/flow";
import type { QuizQuestionV2 } from "@/core/script/v2/schema";
import { validatePlayerActionPlan } from "./plan";

/** JSON 决策解析失败时的重采样次数；全部失败走各自的兜底（随机/默认值） */
const JSON_DECISION_RETRIES = 3;
/** 叙述类调用的保守解码参数：轻度罚重对冲复读倾向；决策/JSON 类调用不受影响 */
const NARRATIVE_SAMPLING = { topP: 0.95, frequencyPenalty: 0.3, presencePenalty: 0.1 } as const;
/** 推荐给真人的一键接话短句条数上限 */
const MAX_SUGGESTIONS = 3;
/** 守卫放行后的发言截断上限：问题/投票理由/私信各按其体裁封顶 */
const MAX_QUESTION_CHARS = 200;
const MAX_VOTE_REASON_CHARS = 120;
const MAX_WHISPER_CHARS = 300;

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
      script: ctx.script,
    });
    if (!lines.length) return "";
    return `【旧事重提·与当前话题相关（帮你对照前后说法）】\n${lines.map((l) => `· ${l.label}：${l.text}`).join("\n")}`;
  } catch {
    return "";
  }
}

/** agent ↔ llm client 的唯一出口：每次请求都带上分段，客户端才能按分层预算降级。 */
function playerPrompt(ctx: AgentCtx, seatIndex: number, opts: Parameters<typeof buildPlayerContext>[4]) {
  const a = buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, opts);
  return { messages: a.messages, segments: a.segments };
}

function dmPrompt(ctx: AgentCtx, opts: Parameters<typeof buildDmContext>[3]) {
  const a = buildDmContext(ctx.script, ctx.state, ctx.events, opts);
  return { messages: a.messages, segments: a.segments };
}

export const agent = {
  async playerInteraction(ctx: AgentCtx, seatIndex: number, beat: NonNullable<AgentCtx["script"]["flow"]["interactionBeats"]>[number]): Promise<string> {
    const res = await chat({ purpose: seatPurpose(ctx.script, ctx.state, seatIndex), gameId: ctx.gameId, taskType: "interaction_choice", maxTokens: 256,
      ...playerPrompt(ctx, seatIndex, { requireJson: `按你的角色视角作出选择：${beat.prompt}。选项：${beat.choices.map((choice) => `${choice.id}: ${choice.label}`).join("；")}。只输出 JSON：{"choiceId":"选项id"}` }) });
    const parsed = extractJson<{ choiceId?: string }>(res.text);
    return beat.choices.some((choice) => choice.id === parsed?.choiceId) ? parsed!.choiceId! : beat.defaultChoiceId;
  },
  /** 正式发言前的一次轻量规划；无效 JSON 不阻断原有发言流程。 */
  async playerActionPlan(ctx: AgentCtx, seatIndex: number): Promise<PlayerActionPlan | null> {
    const requireJson = `请先做一个极简行动计划，只输出 JSON：{"objectiveId":"你当前最优先目标的 id 或 null","targetSeat":对方座位索引或 null,"discloseClueIds":["准备公开的线索 id"],"holdClueIds":["准备保留的线索 id"],"focusEvidenceIds":["本回合引用的可见线索id"],"claimSummary":"80字以内的唯一新增主张","defenseHookId":"仍成立的辩解id或null","nextAction":"state|ask|defend|probe|exchange|wait"}。只能引用你当前合法可见的目标和线索，不要写秘密原文。`;
    try {
      const res = await chat({ purpose: seatPurpose(ctx.script, ctx.state, seatIndex), gameId: ctx.gameId, ...playerPrompt(ctx, seatIndex, { requireJson, taskType: "plan" }), temperature: 0.3, maxTokens: 512, taskType: "action_plan" });
      return validatePlayerActionPlan(ctx, seatIndex, extractJson(res.text));
    } catch {
      return null;
    }
  },
  /** DM 开场白 / 转场旁白 */
  async dmNarrate(ctx: AgentCtx, task: string): Promise<string> {
    const res = await chat({
      purpose: "dm",
      gameId: ctx.gameId,
      ...dmPrompt(ctx, { task, recall: await recallFor(ctx, null) }),
      temperature: 0.7,
      ...NARRATIVE_SAMPLING,
    });
    return guardDmSpeech(ctx.script, ctx.state, res.text).text;
  },

  /** DM 旁白（真流式）：句子级增量守卫，泄露句不会被放出。 */
  async *streamDmNarrate(ctx: AgentCtx, task: string, abortSignal?: AbortSignal, generationId?: string): AsyncGenerator<string> {
    const prompt = dmPrompt(ctx, { task, recall: await recallFor(ctx, null) });
    const redactor = createSpeechRedactor(dmGuardMarkers(ctx.script, ctx.state));
    for await (const chunk of chatStream({ purpose: "dm", gameId: ctx.gameId, ...prompt, temperature: 0.7, ...NARRATIVE_SAMPLING, abortSignal, generationId, taskType: "dm_narration" })) {
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

  /** 玩家自我介绍 / 发言（带泄密守卫与一次重试） */
  async playerSpeak(ctx: AgentCtx, seatIndex: number, opts: { intro?: boolean; hint?: string; recall?: string; abortSignal?: AbortSignal; generationId?: string; taskType?: "speech" | "answer" } = {}): Promise<string> {
    const build = (anchor = false) =>
      playerPrompt(ctx, seatIndex, {
        hint: opts.hint,
        extraInstruction: [opts.intro ? "这是你的自我介绍环节。" : "", anchor ? ROLE_ANCHOR : ""].filter(Boolean).join("\n") || undefined,
        recall: opts.recall,
        taskType: opts.taskType ?? (opts.intro ? "speech" : "speech"),
      });
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    const say = async (taskType: string, anchor = false) =>
      guardPlayerSpeech(ctx.script, ctx.state, seatIndex, (await chat({ purpose, gameId: ctx.gameId, temperature: 0.85, ...NARRATIVE_SAMPLING, abortSignal: opts.abortSignal, generationId: opts.generationId, ...build(anchor), taskType })).text);
    let guarded = await say(opts.intro ? "self_intro" : opts.taskType ?? "speech");
    // 拒绝语被当成正文返回时不报错，只能按台词判定：补角色锚定重发一次，仍是被拒就当没有发言。
    if (isRefusalBoilerplate(guarded.text)) {
      console.warn(`[llm] speech_refusal_reanchor task=${opts.intro ? "self_intro" : opts.taskType ?? "speech"} seat=${seatIndex}`);
      guarded = await say("speech_refusal_reanchor", true);
    }
    if (isRefusalBoilerplate(guarded.text)) return "";
    if (guarded.leaked.length) {
      const guarded2 = await say(opts.intro ? "self_intro_retry" : "speech_retry");
      if (guarded2.text.length >= Math.min(20, guarded.text.length)) guarded = guarded2;
    }
    return guarded.text;
  },

  /** 玩家发言（真流式）：句子级增量守卫，泄露句不会被放出（替代先全文守卫再打字机的旧方案）。 */
  async *streamPlayerSpeech(
    ctx: AgentCtx,
    seatIndex: number,
    opts: { intro?: boolean; hint?: string; extraInstruction?: string; recall?: string; abortSignal?: AbortSignal; generationId?: string; taskType?: "speech" | "answer" | "whisper" } = {}
  ): AsyncGenerator<string> {
    const prompt = playerPrompt(ctx, seatIndex, {
      hint: opts.hint,
      extraInstruction: opts.intro ? "这是你的自我介绍环节。" : opts.extraInstruction,
      recall: opts.recall ?? (await recallFor(ctx, seatIndex)),
      taskType: opts.taskType ?? (opts.intro ? "speech" : "speech"),
    });
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    const redactor = createSpeechRedactor(playerGuardMarkers(ctx.script, ctx.state, seatIndex));
    let emitted = false;
    try {
      for await (const chunk of chatStream({ purpose, gameId: ctx.gameId, ...prompt, temperature: 0.85, ...NARRATIVE_SAMPLING, abortSignal: opts.abortSignal, generationId: opts.generationId, taskType: opts.intro ? "self_intro" : opts.taskType ?? "speech" })) {
        const delta = redactor.push(chunk);
        // 审核话术有时被当正文吐出：不放出也不计入文本，让调用方按"没有发言"兜底重发。
        if (!delta || isRefusalBoilerplate(delta)) continue;
        emitted = true;
        yield delta;
      }
      const { delta } = redactor.flush();
      if (delta && !isRefusalBoilerplate(delta)) {
        emitted = true;
        yield delta;
      }
    } catch (err) {
      if (!emitted && isSafetyRefusal(err)) {
        console.warn(`[llm] stream_refusal_fallback task=${opts.intro ? "self_intro" : opts.taskType ?? "speech"} seat=${seatIndex}`);
        return;
      }
      throw err;
    }
  },

  /**
   * ★ 二次审查 ★（critique→refine）：启发式怀疑出戏/复读时，用一次廉价调用判定并最小修改。
   * 没有可疑信号时直接返回原文（零额外成本）。
   * 本地启发式只负责「值不值得送审」，改不改以审查员的判断为准（它判 ok 就保留原文）；
   * 只有审查员自己给出改写、或改写后仍然冗余、或审查调用失败时，才退到该座位的短话。
   */
  async refineSpeech(ctx: AgentCtx, seatIndex: number, text: string, opts: { abortSignal?: AbortSignal; generationId?: string } = {}): Promise<string> {
    const character = characterOf(ctx.script, ctx.state, seatIndex);
    const card = character?.privateCard;
    const held = new Set(ctx.state.heldClues[seatIndex] ?? []);
    const ownCorpus = [
      card ? narrativeToText(card.backstory) : "",
      card ? timelineToText(card.timeline) : "",
      ...(card?.knowledge.map((item) => narrativeToText(item.content)) ?? []),
      ...(card?.secrets.map((item) => narrativeToText(item.content)) ?? []),
      ...ctx.script.clues.filter((clue) => held.has(clue.id) || ctx.state.clueStates[clue.id]?.isPublic).map((clue) => clueText(clue)),
    ].join("\n");
    const others = ctx.events
      .filter((ev) => ev.type === "speech" && ev.fromSeat !== seatIndex && ev.fromSeat != null && ev.content.text)
      .map((ev) => ({ name: String(ev.content.speakerName ?? "对方"), text: String(ev.content.text) }));
    const spoken = rewriteAppropriatedWitness(text, ownCorpus, others);
    const ownLast = lastOwnSpeechText(ctx.events, seatIndex);
    const plan = ctx.state.actionPlans?.[String(seatIndex)];
    const prior = ctx.events.filter((ev) => ev.type === "speech" && ev.visibility === "public" && ev.phase === ctx.state.phase && ev.round === ctx.state.round);
    const novelty = makeNoveltyJudge(ctx.script, ctx.events, ctx.state.phase, ctx.state.round, plan?.focusEvidenceIds ?? []);
    const repeated = (candidate: string) => novelty.judgeable && prior.some((ev) => bigramSimilarity(candidate, String(ev.content.text ?? "")) >= 0.72 && !novelty.novelVs(candidate, ev));
    if (spoken !== text && !shouldReviewSpeech(spoken, ownLast) && !repeated(spoken)) return spoken;
    const duplicateClaim = Boolean(novelty.judgeable && plan?.claimSummary && prior.some((ev) => ev.content.claimSummary && bigramSimilarity(plan.claimSummary!, String(ev.content.claimSummary)) >= 0.72 && !novelty.novelVs(text, ev)));
    const suspicion = [shouldReviewSpeech(text, ownLast) ? "ooc" : "", repeated(text) ? "repeated" : "", duplicateClaim ? "claim" : ""].filter(Boolean).join("+");
    const trace = (outcome: string, finalText: string) => {
      if (finalText === text && outcome === "keep") return;
      console.warn(`[agents] speech_refine game=${ctx.gameId} seat=${seatIndex} fired=${suspicion} outcome=${outcome} from="${text.slice(0, 40)}" to="${finalText.slice(0, 40)}"`);
    };
    if (!suspicion) return spoken;
    const targetName = plan?.targetSeat == null ? null : characterOf(ctx.script, ctx.state, plan.targetSeat)?.name ?? ctx.state.seats[plan.targetSeat]?.playerName ?? null;
    const degraded = () => degradedSpeechLine(plan, targetName);
    try {
      const res = await chat({
        purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
        gameId: ctx.gameId,
        temperature: 0.1,
        maxTokens: 1024,
        abortSignal: opts.abortSignal,
        generationId: opts.generationId,
        taskType: "speech_review",
        messages: [
          {
            role: "system",
            content:
              "你是剧本杀台词审查员。检查给定台词是否违规：1) 出戏（出现 AI/助手/游戏机制/系统提示等元话语，或舞台指示）；2) 与本轮任何角色的主张重复且没有新证据；3) 主动承认推翻当前仍成立辩解的事实。只贡献一个新主张，40-120字。只做最小修改、保持角色口吻与原意。只输出 JSON：{\"ok\":true} 或 {\"ok\":false,\"text\":\"修改后的台词\"}。",
          },
          {
            role: "user",
            content: `【本轮主张】${prior.map((ev) => ev.content.claimSummary ?? ev.content.text).join("；")}\n【当前辩解】${characterOf(ctx.script, ctx.state, seatIndex)?.privateCard.defenseHooks.find((h) => h.id === plan?.defenseHookId)?.claim ?? "无"}\n【台词】\n${spoken}\n${ownLast ? `\n【该角色上一段发言】\n${ownLast}` : ""}`,
          },
        ],
      });
      const parsed = extractJson<{ ok?: boolean; text?: string }>(res.text);
      if (parsed?.ok === true) {
        if (repeated(text) || duplicateClaim) {
          trace("reviewer_keep_rejected", degraded());
          return degraded();
        }
        trace("reviewer_keep", spoken);
        return spoken;
      }
      if (parsed && parsed.ok === false && typeof parsed.text === "string") {
        const refined = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, parsed.text.trim());
        if (refined.text.length >= Math.min(20, text.length)) {
          if (repeated(refined.text)) {
            trace("reviewer_redundant", degraded());
            return degraded();
          }
          trace("reviewer_fix", refined.text);
          return refined.text;
        }
      }
    } catch {
      /* 审查失败就按本地判据处理 */
    }
    if (repeated(text) || duplicateClaim) {
      trace("degraded", degraded());
      return degraded();
    }
    trace("keep", spoken);
    return spoken;
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
      ...playerPrompt(ctx, seatIndex, { requireJson }),
      temperature: 0.5,
    });
    const parsed = extractJson<{ whisper?: boolean; to?: number; text?: string }>(res.text);
    if (!parsed?.whisper || parsed.to === undefined) return null;
    const toSeat = parsed.to - 1;
    const text = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, (parsed.text ?? "").trim()).text;
    if (!humanSeats.includes(toSeat) || !text) return null;
    return { toSeat, text: text.slice(0, MAX_WHISPER_CHARS) };
  },

  /** ★ 推荐回复 ★：轮到真人发言时，后台生成 3 条可直接说出口的短句（同样过守卫）。 */
  async suggestReplies(ctx: AgentCtx, seatIndex: number): Promise<string[]> {
    const requireJson = `请结合当前局面与你的处境，给出 3 条你现在可以直接说出口的短句，帮助玩家快速接话。要求：每条不超过 40 字，中文口语，符合你的人设、秘密与目标；可以是陈述、反问或试探；不要舞台指示，不要复读别人刚说过的话。请只输出 JSON：{"suggestions":["...","...","..."]}`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      ...playerPrompt(ctx, seatIndex, { requireJson }),
      temperature: 0.9,
      ...NARRATIVE_SAMPLING,
    });
    const parsed = extractJson<{ suggestions?: unknown }>(res.text);
    if (!Array.isArray(parsed?.suggestions)) return [];
    const guard = (s: unknown): string | null => {
      if (typeof s !== "string") return null;
      const text = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, s.trim().slice(0, 60)).text;
      return text || null;
    };
    return parsed.suggestions.map(guard).filter((s): s is string => s !== null).slice(0, MAX_SUGGESTIONS);
  },

  /** 玩家选择搜证地点 */
  async playerChooseLocation(ctx: AgentCtx, seatIndex: number, locations: string[]): Promise<string> {
    const character = characterOf(ctx.script, ctx.state, seatIndex);
    const asCulprit = character?.privateCard.isCulprit
      ? "若某地可能藏着对你不利的证据，优先去拿走它。"
      : "按你自己的目标和已知情报选择，不必像侦探一样搜遍所有关键地点。";
    const requireJson = `请只输出 JSON：{"location":"你选择的地点"}。候选地点：${locations.join("、")}。${asCulprit}`;
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    for (let i = 0; i < JSON_DECISION_RETRIES; i++) {
      const res = await chat({ purpose, gameId: ctx.gameId, ...playerPrompt(ctx, seatIndex, { requireJson }), temperature: 0.6 });
      const parsed = extractJson<{ location?: string }>(res.text);
      if (parsed?.location && locations.includes(parsed.location)) return parsed.location;
    }
    // 不再自己随机：抛给引擎的兜底分支，那边才知道"这一票/这一步不是模型决定"，
    // 也才能在同一处先问一次 Jev 再落回随机。
    throw new Error(`agent_decision_unavailable:location seat=${seatIndex}`);
  },

  /** 玩家决定线索公开还是私藏 */
  async playerChoosePublish(ctx: AgentCtx, seatIndex: number, clueId: string): Promise<boolean> {
    const clue = ctx.script.clues.find((c) => c.id === clueId);
    if (!clue) return false;
    const requireJson = `你刚搜到线索卡【${clue.name}】（地点：${locationNameOf(ctx.script, clue.locationId)}）。内容：${clueText(clue)}。请只输出 JSON：{"publish":true/false}。publish=true 表示当场公开给大家，false 表示私藏。判断依据：公开对你有利/能推进调查就公开；线索指向你自己或暴露你的秘密就私藏。`;
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    for (let i = 0; i < JSON_DECISION_RETRIES; i++) {
      const res = await chat({ purpose, gameId: ctx.gameId, ...playerPrompt(ctx, seatIndex, { requireJson }), temperature: 0.5 });
      const parsed = extractJson<{ publish?: boolean }>(res.text);
      if (typeof parsed?.publish === "boolean") return parsed.publish;
    }
    throw new Error(`agent_decision_unavailable:publish seat=${seatIndex} clue=${clueId}`);
  },

  /** 讨论阶段：决定是否当众提问。无必要则返回 null。 */
  async playerConsiderQuestion(
    ctx: AgentCtx,
    seatIndex: number,
    candidates: number[],
  ): Promise<{ toSeat: number; question: string; evidenceIds: string[] } | null> {
    if (!candidates.length) return null;
    const roster = candidates
      .map((i) => {
        const seat = ctx.state.seats[i];
        const name = ctx.script.characters.find((c) => c.id === seat?.characterId)?.name ?? seat?.playerName ?? `座位${i + 1}`;
        return `${i + 1}:${name}`;
      })
      .join("、");
    const publicEvidenceIds = ctx.script.clues.filter((clue) => ctx.state.clueStates[clue.id]?.isPublic).map((clue) => clue.id);
    const askedThisRound = ctx.events
      .filter((event) => event.type === "speech" && event.phase === "DISCUSSION" && event.round === ctx.state.round && event.content.questionId && !event.content.answer && event.toSeat !== null)
      .map((event) => `${event.toSeat! + 1}:${event.content.text ?? ""}`)
      .join("；");
    const requireJson = `现在轮到你发言。若有一个具体疑点需要对方当众回答，可提问一次；没有必要就不要问。请只输出 JSON：{"ask":false} 或 {"ask":true,"target":座位号,"question":"一个具体问题","evidenceIds":["公开线索id"]}。可问：${roster}。可引用的公开线索 ID：${publicEvidenceIds.join("、") || "（暂无）"}。本轮全场已经问过：${askedThisRound || "（暂无）"}。有公开线索时必须引用至少一张与问题相关的线索；不要重复相同目标和相同证据组合，不要一次抛多个问题，也不要审问式连问。`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      ...playerPrompt(ctx, seatIndex, { requireJson }),
      temperature: 0.5,
    });
    const parsed = extractJson<{ ask?: boolean; target?: number; question?: string; evidenceIds?: string[] }>(res.text);
    if (!parsed?.ask || parsed.target === undefined) return null;
    const toSeat = parsed.target - 1;
    // 提问会以本人公开发言进入事件流,同样要过泄露守卫;剥空则放弃提问
    const guarded = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, (parsed.question ?? "").trim());
    const question = guarded.text;
    if (!candidates.includes(toSeat) || !question) return null;
    const evidenceIds = [...new Set(parsed.evidenceIds ?? [])].filter((id) => publicEvidenceIds.includes(id));
    if (publicEvidenceIds.length && !evidenceIds.length) return null;
    return { toSeat, question: question.slice(0, MAX_QUESTION_CHARS), evidenceIds };
  },

  /** 复盘答题：根据情报与推理作答（问题id→选项id；非法/缺题由引擎随机兜底） */
  async quizAnswer(ctx: AgentCtx, seatIndex: number, questions: ReadonlyArray<QuizQuestionV2>): Promise<Record<string, string>> {
    if (!questions.length) return {};
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      ...playerPrompt(ctx, seatIndex, { requireJson: quizPrompt(questions) }),
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
  async playerVote(ctx: AgentCtx, seatIndex: number, candidates: number[]): Promise<{ target: number; reason: string; evidenceIds: string[] }> {
    const character = characterOf(ctx.script, ctx.state, seatIndex);
    const asCulprit = character?.privateCard.isCulprit;
    const publicEvidenceIds = ctx.script.clues.filter((clue) => ctx.state.clueStates[clue.id]?.isPublic).map((clue) => clue.id);
    const requireJson = asCulprit
      ? `请只输出 JSON：{"target":座位号,"reason":"一句话理由","evidenceIds":["公开线索id"]}。可投座位：${candidates.map((n) => n + 1).join("、")}（不能投自己）。把票投给一个能让你脱身的人，理由必须听起来像基于公开讨论。可引用公开线索 ID：${publicEvidenceIds.join("、") || "（暂无）"}。`
      : `请只输出 JSON：{"target":座位号,"reason":"一句话理由","evidenceIds":["公开线索id"]}。可投座位：${candidates.map((n) => n + 1).join("、")}（不能投自己）。你不是全知侦探：只根据公开发言和已公开线索投票，不要把只有你知道的私密情报当成全场共识。可引用公开线索 ID：${publicEvidenceIds.join("、") || "（暂无）"}。证据并不充分时，投疑点较大的人即可，不要表现得像已经知道答案。`;
    const purpose = seatPurpose(ctx.script, ctx.state, seatIndex);
    for (let i = 0; i < JSON_DECISION_RETRIES; i++) {
      const res = await chat({ purpose, gameId: ctx.gameId, ...playerPrompt(ctx, seatIndex, { requireJson }), temperature: 0.4 });
      const parsed = extractJson<{ target?: number; reason?: string; evidenceIds?: string[] }>(res.text);
      if (parsed?.target !== undefined) {
        const t = parsed.target - 1;
        if (candidates.includes(t) && t !== seatIndex) {
          // 理由同样公开发言,过泄露守卫;剥空降级为无理由投票
          const reason = guardPlayerSpeech(ctx.script, ctx.state, seatIndex, (parsed.reason ?? "").trim()).text;
          const evidenceIds = [...new Set(parsed.evidenceIds ?? [])].filter((id) => publicEvidenceIds.includes(id));
          if (publicEvidenceIds.length && !evidenceIds.length) continue;
          return { target: t, reason: reason.slice(0, MAX_VOTE_REASON_CHARS), evidenceIds };
        }
      }
    }
    throw new Error(`agent_decision_unavailable:vote seat=${seatIndex}`);
  },

  /** 私聊回复 */
  async privateReply(ctx: AgentCtx, seatIndex: number, fromSeat: number, message: string): Promise<string> {
    const other = ctx.state.seats[fromSeat]?.playerName ?? `玩家${fromSeat + 1}`;
    const res = await chat({
      purpose: seatPurpose(ctx.script, ctx.state, seatIndex),
      gameId: ctx.gameId,
      ...playerPrompt(ctx, seatIndex, {
        hint: `私聊窗口：${other} 悄悄对你说：「${message}」。请以私聊口吻回复（可交换情报、试探、结盟或敷衍），40-120 字。`,
        taskType: "whisper",
      }),
      temperature: 0.8,
      ...NARRATIVE_SAMPLING,
    });
    return guardPlayerSpeech(ctx.script, ctx.state, seatIndex, res.text).text;
  },
};
