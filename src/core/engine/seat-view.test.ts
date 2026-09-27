import { describe, expect, it } from "vitest";
import { parseScriptForRuntime } from "@/core/script/compat";
import type { ScriptDocV2 } from "@/core/script/v2/schema";
import { gameRow, scriptRow, seatRow } from "@/test/fixtures";
import type { GameState } from "./types";
import { buildSeatView } from "./seat-view";

function docFixture(): ScriptDocV2 {
  return parseScriptForRuntime(scriptRow().content);
}

function stateFixture(overrides: Record<string, unknown> = {}): GameState {
  return {
    stateVersion: 1,
    phase: "DISCUSSION",
    round: 1,
    seats: [],
    clueStates: {},
    heldClues: {},
    readySeats: [],
    spokenSeats: [],
    turnSeat: null,
    votes: {},
    privateChat: {},
    searchChoices: {},
    pendingPublish: {},
    searchDealtRound: 0,
    voteResult: null,
    interjections: 0,
    questionsLeft: {},
    pendingAnswer: null,
    ...overrides,
  } as GameState;
}

function viewFixture(args: { mySeat?: number | null; doc?: ScriptDocV2; state?: GameState } = {}) {
  const doc = args.doc ?? docFixture();
  const roomSeats = doc.characters.slice(0, 3).map((character, index) =>
    seatRow({
      id: `seat-${index}`,
      index,
      kind: index === 0 ? "human" : "ai",
      playerName: index === 0 ? "玩家一" : null,
      token: index === 0 ? "seat-token-1" : null,
      characterId: character.id,
    }),
  );
  const game = {
    ...gameRow({ status: "running", phase: args.state?.phase ?? "DISCUSSION", round: args.state?.round ?? 1 }),
    room: { id: "room-1", code: "ABCDE", seats: roomSeats },
  };
  return buildSeatView({
    game: game as never,
    doc,
    runtimeState: args.state ?? stateFixture(),
    mySeat: args.mySeat ?? null,
  });
}

describe("buildSeatView 信息隔离", () => {
  it("观战者看不到任何座位的 myCard", () => {
    const view = viewFixture();
    expect(view.seats.every((seat) => seat.myCard === null)).toBe(true);
  });

  it("观战者看不到任何座位的 myCardV2", () => {
    const view = viewFixture();
    expect(view.seats.every((seat) => seat.myCardV2 === null)).toBe(true);
  });

  it("观战者看不到 heldClues 中的 myClues", () => {
    const view = viewFixture({ state: stateFixture({ heldClues: { 0: ["private-clue"] } }) });
    expect(view.myClues).toEqual([]);
  });

  it("观战者看不到 pendingAnswer", () => {
    const view = viewFixture({ state: stateFixture({ pendingAnswer: { fromSeat: 0, toSeat: 1, question: "私密状态" } }) });
    expect(view.pendingAnswer).toBeNull();
  });

  it("观战者看不到 suggestions", () => {
    const view = viewFixture({ state: stateFixture({ suggestions: { "0": ["私密建议"] } }) });
    expect(view.suggestions).toEqual([]);
  });

  it("观战者看不到 openWhispers", () => {
    const view = viewFixture({ state: stateFixture({ privateChat: { "1-0": 1 } }) });
    expect(view.openWhispers).toEqual([]);
  });

  it("观战者看不到技能卡", () => {
    const doc = docFixture();
    doc.flow.actionPointsPerRound = 2;
    doc.characters[0].privateCard.skills = [{ id: "private-skill", name: "质询", description: "私密技能", cost: 1, phase: "DISCUSSION", effect: "verify", once: true }];
    const view = viewFixture({ doc, state: stateFixture({ actionPoints: { "0": 2 } }) });
    expect(view.skills).toEqual([]);
  });

  it("观战者看不到私聊窗口的座位列表", () => {
    const view = viewFixture({ state: stateFixture({ privateChat: { "1-0": 2, "2-0": 1 } }) });
    expect(view.openWhispers).toEqual([]);
  });

  it("座位 A 看不到座位 B 的 myCardV2", () => {
    const view = viewFixture({ mySeat: 0 });
    expect(view.seats[0].myCardV2).not.toBeNull();
    expect(view.seats[1].myCardV2).toBeNull();
    expect(view.seats[1].myCard).toBeNull();
  });

  it("myCardV2 的 stages 只包含已解锁幕", () => {
    const doc = docFixture();
    doc.flow.acts = [
      { id: "act-open", title: "已开启", brief: [], roundStart: 1 },
      { id: "act-locked", title: "未开启", brief: [], roundStart: 3 },
    ];
    doc.characters[0].privateCard.stages = [
      { actId: "act-open", knowledge: [], objectives: [] },
      { actId: "act-locked", knowledge: [], objectives: [] },
    ];
    const view = viewFixture({ mySeat: 0, doc, state: stateFixture({ phase: "SEARCH", round: 2 }) });
    expect(view.seats[0].myCardV2?.stages.map((stage) => stage.actId)).toEqual(["act-open"]);
  });

  it("quiz 不返回正确选项标记", () => {
    const doc = docFixture();
    doc.flow.voteMode = "choice";
    doc.ending.quiz = [{ id: "q1", prompt: "问题", options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }], correctOptionId: "b", weight: 1 }];
    const view = viewFixture({ mySeat: 0, doc });
    expect(view.quiz?.questions[0].options).toEqual([{ id: "a", label: "甲" }, { id: "b", label: "乙" }]);
    expect(view.quiz?.questions[0]).not.toHaveProperty("correctOptionId");
  });

  it("quizResult 只在 ENDED 返回", () => {
    const quizResult = { perSeat: {}, perQuestion: [] };
    const running = viewFixture({ state: stateFixture({ phase: "REVEAL", quizResult }) });
    const ended = viewFixture({ state: stateFixture({ phase: "ENDED", quizResult }) });
    expect(running.quizResult).toBeNull();
    expect(ended.quizResult).toEqual(quizResult);
  });

  it("interactionBeats 只包含 public", () => {
    const doc = docFixture();
    doc.flow.interactionBeats = [
      { id: "public-beat", round: 1, timing: "after_discussion", characterId: doc.characters[0].id, prompt: "公开互动", choices: [{ id: "a", label: "甲", recap: "甲" }, { id: "b", label: "乙", recap: "乙" }], defaultChoiceId: "a", visibility: "public" },
      { id: "private-beat", round: 1, timing: "after_discussion", characterId: doc.characters[0].id, prompt: "私密互动", choices: [{ id: "a", label: "甲", recap: "甲" }, { id: "b", label: "乙", recap: "乙" }], defaultChoiceId: "a", visibility: "private" },
    ];
    const view = viewFixture({ doc });
    expect(view.flow.interactionBeats?.map((beat) => beat.id)).toEqual(["public-beat"]);
  });

  it("flow 与响应根对象均不包含 truth 字段", () => {
    const view = viewFixture();
    expect(view.flow).not.toHaveProperty("truth");
    expect(view.flow).not.toHaveProperty("culpritId");
    expect(view).not.toHaveProperty("truth");
    expect(view).not.toHaveProperty("culpritId");
  });
});
