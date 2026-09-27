import { describe, expect, it, vi } from "vitest";
import type { GameEngine, GameAction } from "../engine";
import { DM_ACTIONS, PLAYER_ACTIONS, type DmAction } from "./index";

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      game: { update: vi.fn().mockResolvedValue({ roomId: "room-1" }) },
      room: { update: vi.fn().mockResolvedValue({}) },
    })),
  },
}));

function engine(phase = "READING") {
  return {
    gameId: "game-1",
    script: {
      flow: { allowPrivateChat: false, allowClueTransfer: false, actionPointsPerRound: 0, voteMode: "culprit" },
      clues: [],
      characters: [],
      ending: { quiz: [] },
    },
    state: {
      phase,
      round: 1,
      seats: [{ index: 0, kind: "human", characterId: "char-0" }, { index: 1, kind: "ai", characterId: "char-1" }],
      pendingAnswer: null,
      turnSeat: null,
      readySeats: [],
      hostGuide: { stallBreakers: [] },
    },
    clearTimers: vi.fn(),
    continueTick: vi.fn(),
    persist: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    systemSay: vi.fn(async () => undefined),
    markSpoken: vi.fn(),
    nextTurnOrAdvance: vi.fn(async () => undefined),
  } as unknown as GameEngine;
}

describe("player action handlers", () => {
  it("interaction handler rejects when no choice is pending", async () => {
    expect(await PLAYER_ACTIONS.interaction(engine() as GameEngine, 0, { type: "interaction" })).toMatchObject({ ok: false });
  });
  it("ready handler rejects outside reading", async () => {
    expect(await PLAYER_ACTIONS.ready(engine("DISCUSSION"), 0, { type: "ready" })).toMatchObject({ ok: false, error: "当前不在读本环节" });
  });
  it("speak handler rejects empty text", async () => {
    expect(await PLAYER_ACTIONS.speak(engine(), 0, { type: "speak", text: "  " })).toMatchObject({ ok: false, error: "发言不能为空" });
  });
  it("ask handler rejects outside discussion", async () => {
    expect(await PLAYER_ACTIONS.ask(engine(), 0, { type: "ask", toSeat: 1, text: "问题" })).toMatchObject({ ok: false, error: "当前不在讨论环节" });
  });
  it("skip handler rejects outside a speaking phase", async () => {
    expect(await PLAYER_ACTIONS.skip(engine(), 0, { type: "skip" })).toMatchObject({ ok: false });
  });
  it("choose_location handler rejects outside search", async () => {
    expect(await PLAYER_ACTIONS.choose_location(engine(), 0, { type: "choose_location" })).toMatchObject({ ok: false, error: "当前不在搜证环节" });
  });
  it("publish handler rejects outside search", async () => {
    expect(await PLAYER_ACTIONS.publish(engine(), 0, { type: "publish" })).toMatchObject({ ok: false, error: "当前不在搜证环节" });
  });
  it("vote handler rejects outside vote", async () => {
    expect(await PLAYER_ACTIONS.vote(engine(), 0, { type: "vote" })).toMatchObject({ ok: false, error: "当前不在投票环节" });
  });
  it("answer_quiz handler rejects outside vote", async () => {
    expect(await PLAYER_ACTIONS.answer_quiz(engine(), 0, { type: "answer_quiz" })).toMatchObject({ ok: false, error: "当前不在投票/复盘环节" });
  });
  it("use_skill handler validates the skill before applying it", async () => {
    expect(await PLAYER_ACTIONS.use_skill(engine(), 0, { type: "use_skill", skillId: "missing" })).toMatchObject({ ok: false, error: "本局未开启技能系统" });
  });
  it("transfer handler validates phase before changing ownership", async () => {
    expect(await PLAYER_ACTIONS.transfer(engine(), 0, { type: "transfer", toSeat: 1, clueId: "clue-1" })).toMatchObject({ ok: false, error: "当前不在讨论环节" });
  });
  it("private_chat handler rejects when the feature is disabled", async () => {
    expect(await PLAYER_ACTIONS.private_chat(engine("DISCUSSION"), 0, { type: "private_chat" })).toMatchObject({ ok: false, error: "本局未开放私聊" });
  });
  it("rush handler requests a tick", async () => {
    const e = engine();
    expect(await PLAYER_ACTIONS.rush(e, 0, { type: "rush" })).toEqual({ ok: true });
    expect(e.continueTick).toHaveBeenCalledOnce();
  });
});

describe("DM action handlers", () => {
  it("force_ready handler rejects outside reading", async () => {
    expect(await DM_ACTIONS.force_ready(engine("DISCUSSION"), { type: "force_ready", seatIndex: 0 })).toMatchObject({ ok: false });
  });
  it("abort_game handler persists the ended state", async () => {
    const e = engine();
    expect(await DM_ACTIONS.abort_game(e, { type: "abort_game" })).toEqual({ ok: true });
    expect(e.state.phase).toBe("ENDED");
    expect(e.persist).toHaveBeenCalledOnce();
  });
  it("narrate handler rejects empty text", async () => {
    expect(await DM_ACTIONS.narrate(engine(), { type: "narrate", text: "  " })).toMatchObject({ ok: false, error: "内容不能为空" });
  });
  it("nudge handler requests a tick", async () => {
    const e = engine();
    expect(await DM_ACTIONS.nudge(e, { type: "nudge" })).toEqual({ ok: true });
    expect(e.continueTick).toHaveBeenCalledOnce();
  });
  it("skip_turn handler requests a tick without a current turn", async () => {
    const e = engine();
    expect(await DM_ACTIONS.skip_turn(e, { type: "skip_turn" })).toEqual({ ok: true });
    expect(e.continueTick).toHaveBeenCalledOnce();
  });
  it("handout handler rejects an unknown clue", async () => {
    expect(await DM_ACTIONS.handout(engine(), { type: "handout", clueId: "missing" })).toMatchObject({ ok: false, error: "线索不存在" });
  });
  it("hint handler rejects a missing host hint", async () => {
    expect(await DM_ACTIONS.hint(engine(), { type: "hint", hintIndex: 0 })).toMatchObject({ ok: false, error: "主持提示不存在" });
  });
});

it("action handler tables cover all declared player and DM action types", () => {
  const playerTypes: GameAction["type"][] = ["interaction", "ready", "speak", "ask", "skip", "choose_location", "publish", "vote", "answer_quiz", "use_skill", "transfer", "private_chat", "rush"];
  const dmTypes: DmAction["type"][] = ["force_ready", "abort_game", "narrate", "nudge", "skip_turn", "handout", "hint"];
  expect(Object.keys(PLAYER_ACTIONS).sort()).toEqual(playerTypes.sort());
  expect(Object.keys(DM_ACTIONS).sort()).toEqual(dmTypes.sort());
});
