import { createHash } from "node:crypto";
import { buildPlayerContext } from "@/core/agents/context";
import { initialState } from "@/core/engine/state";
import type { EngineEvent, GameState, SeatInfo } from "@/core/engine/types";
import { clueText, narrativeToText } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import type { EvalBundleWithKeys, EvalScene, EvalScoringKey, EvalSnapshot } from "./types";

function scriptHash(script: ScriptDocV2): string {
  return createHash("sha256").update(JSON.stringify(script)).digest("hex");
}

function event(seq: string, fromSeat: number | null, content: EngineEvent["content"], overrides: Partial<EngineEvent> = {}): EngineEvent {
  return {
    seq,
    type: "speech",
    phase: "DISCUSSION",
    round: 1,
    fromSeat,
    toSeat: null,
    visibility: "public",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seatsFor(script: ScriptDocV2): SeatInfo[] {
  return script.characters.map((character, index) => ({
    index,
    kind: "ai",
    characterId: character.id,
    playerName: character.name,
  }));
}

function firstInnocent(script: ScriptDocV2): number {
  const index = script.characters.findIndex((character) => !character.privateCard.isCulprit);
  return index >= 0 ? index : 0;
}

type ConditionalSecret = {
  characterId: string;
  secret: ScriptDocV2["characters"][number]["privateCard"]["secrets"][number];
} | null;

function firstConditional(script: ScriptDocV2): ConditionalSecret {
  for (const character of script.characters) {
    const secret = character.privateCard.secrets.find((item) => item.disclosure === "conditional");
    if (secret) return { characterId: character.id, secret };
  }
  return null;
}

function publicClue(state: GameState, clueId: string): void {
  state.clueStates[clueId] = { discoveredBy: 0, isPublic: true };
}

function makeCase(script: ScriptDocV2, scene: EvalScene, seatIndex: number, conditional: ReturnType<typeof firstConditional>): { state: GameState; events: EngineEvent[]; task: string; constraints: EvalSnapshot["constraints"] } {
  const state = initialState(seatsFor(script));
  const events: EngineEvent[] = [];
  const firstClue = script.clues[0];
  const secondClue = script.clues[1] ?? firstClue;
  const taskByScene: Record<EvalScene, string> = {
    opening: "请做自我介绍，并说明你与死者的关系和今晚的大致行踪。",
    public_evidence: "请回答：刚才公开的物证显示了什么？只根据你合法看到的材料发言。",
    timeline_conflict: "请比较两位玩家关于时间点的说法，指出需要进一步核实的地方。",
    conditional_before: "有人开始追问你的私人经历。请在尚未满足披露条件时回应。",
    conditional_after: "披露条件已经满足。请回应追问，并决定是否按规则说明相关经历。",
    forced_question: "请直接回答对方刚才提出的具体问题，但不要突破你的披露规则。",
    after_transfer: "你刚收到一张线索卡。请说明你现在能依据哪些公开或合法持有的材料发言。",
    pre_vote: "投票前请总结当前公开证据、仍未解决的疑点和你的投票依据。",
  };

  switch (scene) {
    case "public_evidence":
      publicClue(state, firstClue.id);
      events.push({ ...event("1", 0, { clueId: firstClue.id, clueName: firstClue.name, clueContent: clueText(firstClue) }), type: "clue" });
      events.push({ ...event("2", 0, { clueId: firstClue.id, clueName: firstClue.name, clueContent: clueText(firstClue) }), type: "clue", visibility: "public" });
      state.phase = "DISCUSSION";
      state.round = 1;
      break;
    case "timeline_conflict":
      state.phase = "DISCUSSION";
      state.round = 1;
      events.push(event("1", 0, { text: "我记得九点左右一直在大厅。", speakerName: script.characters[0]?.name }));
      events.push(event("2", Math.min(1, script.characters.length - 1), { text: "九点十分我在走廊见过他。", speakerName: script.characters[Math.min(1, script.characters.length - 1)]?.name }));
      break;
    case "conditional_before":
      state.phase = "DISCUSSION";
      state.round = 1;
      if (conditional?.secret.trigger?.publicClueIds?.length) {
        for (const clueId of conditional.secret.trigger.publicClueIds) state.clueStates[clueId] = { discoveredBy: 0, isPublic: false };
      }
      break;
    case "conditional_after":
      state.phase = "DISCUSSION";
      state.round = Math.max(2, conditional?.secret.trigger?.round ?? 2);
      for (const clueId of conditional?.secret.trigger?.publicClueIds ?? []) publicClue(state, clueId);
      break;
    case "forced_question":
      state.phase = "DISCUSSION";
      state.round = 1;
      state.pendingAnswer = { fromSeat: Math.min(1, script.characters.length - 1), toSeat: seatIndex, question: "你昨晚九点在哪里？", forced: true };
      events.push(event("1", state.pendingAnswer.fromSeat, { text: state.pendingAnswer.question, speakerName: script.characters[state.pendingAnswer.fromSeat]?.name, question: true, forced: true }));
      break;
    case "after_transfer":
      state.phase = "DISCUSSION";
      state.round = 1;
      state.heldClues[seatIndex] = [secondClue.id];
      state.clueStates[secondClue.id] = { discoveredBy: 0, isPublic: false };
      events.push({ ...event("1", 0, { clueId: secondClue.id, clueName: secondClue.name, clueContent: clueText(secondClue), text: "你收到了一张线索卡。" }, { type: "transfer", visibility: `seat:${seatIndex}`, toSeat: seatIndex }) });
      break;
    case "pre_vote":
      state.phase = "VOTE";
      state.round = Math.max(1, script.flow.searchRounds);
      publicClue(state, firstClue.id);
      events.push({ ...event("1", 0, { clueId: firstClue.id, clueName: firstClue.name, clueContent: clueText(firstClue) }), type: "clue" });
      break;
    case "opening":
      state.phase = "SELF_INTRO";
      state.round = 1;
      break;
  }

  const constraints: EvalSnapshot["constraints"] = {};
  if (scene === "public_evidence" || scene === "pre_vote") constraints.requiredPublicClueIds = [firstClue.id];
  if (scene === "conditional_before" || scene === "conditional_after") constraints.conditionalSecretId = conditional?.secret.id;
  if (scene === "forced_question") constraints.questionTargetSeat = state.pendingAnswer?.fromSeat;
  return { state, events, task: taskByScene[scene], constraints };
}

function scoringKey(script: ScriptDocV2, snapshot: EvalSnapshot, state: GameState, seatIndex: number, conditional: ReturnType<typeof firstConditional>): EvalScoringKey {
  const mustContainAny = snapshot.constraints.requiredPublicClueIds?.flatMap((id) => {
    const clue = script.clues.find((item) => item.id === id);
    if (!clue) return [];
    const title = clue.name.trim();
    const titleAliases = [
      title,
      title.replace(/(?:残液|报告|记录|目击|证言|本|卡)$/u, ""),
      title.replace(/的(?:日记本|账本|文件)$/u, ""),
    ].filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index);
    const content = narrativeToText(clue.content);
    const chunks = [...content.matchAll(/[一-龥]{2,}/gu)].map((match) => match[0]);
    const anchors = chunks
      .flatMap((chunk) => {
        const values: string[] = [chunk];
        for (let length = Math.min(6, chunk.length); length >= 2; length -= 1) {
          values.push(chunk.slice(0, length), chunk.slice(-length));
        }
        return values;
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 80);
    return [titleAliases, anchors];
  });
  const mustNotContain: string[] = [];
  for (const character of script.characters) {
    if (character.id === script.characters[seatIndex]?.id) continue;
    for (const secret of character.privateCard.secrets) {
      mustNotContain.push(secret.title, narrativeToText(secret.content).slice(0, 24));
    }
  }
  if (snapshot.scene !== "conditional_after") {
    const own = script.characters[seatIndex]?.privateCard.secrets ?? [];
    for (const secret of own.filter((item) => item.disclosure === "never" || (item.disclosure === "conditional" && item.id !== conditional?.secret.id))) {
      mustNotContain.push(secret.title, narrativeToText(secret.content).slice(0, 24));
    }
  }
  return { snapshotId: snapshot.id, mustContainAny, mustNotContain: [...new Set(mustNotContain)] };
}

export function buildFixedEvaluationBundle(script: ScriptDocV2, seatIndex = firstInnocent(script)): EvalBundleWithKeys {
  const hash = scriptHash(script);
  const conditional = firstConditional(script);
  const scenes: EvalScene[] = ["opening", "public_evidence", "timeline_conflict", "conditional_before", "conditional_after", "forced_question", "after_transfer", "pre_vote"];
  const snapshots: EvalSnapshot[] = [];
  const scoringKeys: EvalScoringKey[] = [];
  for (const scene of scenes) {
    const made = makeCase(script, scene, seatIndex, conditional);
    const messages = buildPlayerContext(script, made.state, seatIndex, made.events, { extraInstruction: made.task });
    const snapshot: EvalSnapshot = {
      version: 1,
      id: `${scene}-${hash.slice(0, 12)}`,
      scene,
      scriptHash: hash,
      scriptTitle: script.meta.title,
      seatIndex,
      phase: made.state.phase,
      round: made.state.round,
      task: made.task,
      messages,
      visibleClueIds: script.clues.filter((clue) => made.state.clueStates[clue.id]?.isPublic || (made.state.heldClues[seatIndex] ?? []).includes(clue.id)).map((clue) => clue.id),
      visibleEventSeqs: made.events.filter((item) => item.visibility === "public" || item.visibility === `seat:${seatIndex}` || item.fromSeat === seatIndex).map((item) => item.seq),
      constraints: made.constraints,
    };
    snapshots.push(snapshot);
    scoringKeys.push(scoringKey(script, snapshot, made.state, seatIndex, conditional));
  }
  return { bundle: { version: 1, scriptHash: hash, scriptTitle: script.meta.title, snapshots }, scoringKeys };
}
