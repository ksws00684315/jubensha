import { chat, extractJson } from "@/core/llm/client";
import type { Purpose } from "@/core/llm/types";
import { buildDmContext, buildPlayerContext, characterOf } from "./context";
import { guardDmSpeech, guardPlayerSpeech } from "./guard";
import type { EngineEvent, GameState } from "@/core/engine/types";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { clueText, locationNameOf } from "@/core/script/compat";

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

export const agent = {
  /** DM 开场白 / 转场旁白 */
  async dmNarrate(ctx: AgentCtx, task: string): Promise<string> {
    const res = await chat({
      purpose: "dm",
      gameId: ctx.gameId,
      messages: buildDmContext(ctx.script, ctx.state, ctx.events, { task }),
      temperature: 0.7,
    });
    return guardDmSpeech(ctx.script, ctx.state, res.text).text;
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
  async playerSpeak(ctx: AgentCtx, seatIndex: number, opts: { intro?: boolean; hint?: string } = {}): Promise<string> {
    const build = () =>
      buildPlayerContext(ctx.script, ctx.state, seatIndex, ctx.events, {
        hint: opts.hint,
        extraInstruction: opts.intro ? "这是你的自我介绍环节。" : undefined,
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
