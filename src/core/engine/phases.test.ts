/* eslint-disable @typescript-eslint/no-explicit-any -- 夹具只需引擎实例的结构子集 */
import { describe, expect, it, vi } from "vitest";
import { initialState } from "./state";
import { transitionSearch } from "./phases";
import type { GameEngine } from "./engine";
import type { ActV2 } from "@/core/script/v2/schema";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/core/agents", () => ({ agent: {} }));
vi.mock("./social", () => ({ maybeScheduleSummarize: vi.fn() }));

function fixture(acts: ActV2[]): GameEngine {
  const state = initialState([]);
  Object.assign(state, { phase: "READING", round: 0 });
  const events: any[] = [];
  return {
    state,
    events,
    searchAsked: new Set(),
    publishAsked: new Set(),
    turnAsked: new Set(),
    summaryBoundaries: 0,
    lastSummaryBoundary: -99,
    script: { flow: { acts, searchRounds: 2, discussionRounds: 1, actionPointsPerRound: 0 }, locations: [], clues: [] },
    persist: vi.fn(async () => {}),
    recordEvent: vi.fn(async (ev: any) => {
      events.push(ev);
      return ev;
    }),
    tickInner: vi.fn(async () => {}),
    schedule: vi.fn(),
  } as unknown as GameEngine;
}

const act = (id: string, roundStart: number, brief: string): ActV2 =>
  ({ id, title: `第${roundStart}幕标题`, roundStart, brief: [{ type: "paragraph", text: brief }] }) as ActV2;

describe("分幕旁白的投递可见性", () => {
  it("幕旁白不进公开公告，另发一条 dm 可见事件", async () => {
    const e = fixture([act("a1", 1, "主持密令：本幕只查冰源，不宣布唯一经手人")]);
    await transitionSearch(e, 1);

    const announced = e.events.filter((ev) => ev.visibility === "public");
    expect(announced).toHaveLength(1);
    expect(announced[0].content.text).toContain("进入【第 1 轮搜证】");
    expect(announced[0].content.text).not.toContain("主持密令");
    expect(announced[0].content.text).not.toContain("第1幕标题");

    const hostOnly = e.events.filter((ev) => ev.visibility === "dm");
    expect(hostOnly).toHaveLength(1);
    expect(hostOnly[0].content.text).toContain("主持密令：本幕只查冰源");
    // 真人主持人按 seq 顺序读屏：先听到自己宣的过场，再看到本幕要点
    expect(e.events.indexOf(hostOnly[0])).toBeGreaterThan(e.events.indexOf(announced[0]));
  });

  it("只有本轮对应的幕进主持事件；没有幕的本子一条也不多", async () => {
    const e = fixture([act("a1", 1, "第一幕密令"), act("a2", 2, "第二幕密令")]);
    await transitionSearch(e, 2);
    const hostOnly = e.events.filter((ev) => ev.visibility === "dm");
    expect(hostOnly).toHaveLength(1);
    expect(hostOnly[0].content.text).toContain("第二幕密令");
    expect(hostOnly[0].content.text).not.toContain("第一幕密令");

    const bare = fixture([]);
    await transitionSearch(bare, 1);
    expect(bare.events.filter((ev) => ev.visibility === "dm")).toHaveLength(0);
  });
});
