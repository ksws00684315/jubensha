import { describe, expect, it } from "vitest";
import { decideDmJoin, decideJoin, gameEventsUrl, type JoinableSeat } from "./join";

function seat(partial: Partial<JoinableSeat> & { index: number }): JoinableSeat {
  return {
    id: `s${partial.index}`,
    kind: "human",
    playerName: null,
    token: null,
    characterId: "c1",
    ...partial,
  };
}

describe("decideJoin", () => {
  it("大厅空座可认领", () => {
    const d = decideJoin("lobby", [seat({ index: 0 }), seat({ index: 1, kind: "ai" })], "阿黄");
    expect(d.type).toBe("claim");
    if (d.type === "claim") expect(d.open.map((s) => s.index)).toEqual([0]);
  });

  it("同名已入座则 resume，不占新座", () => {
    const d = decideJoin(
      "playing",
      [seat({ index: 0, playerName: "阿黄", token: "old" }), seat({ index: 1 })],
      "阿黄"
    );
    expect(d).toEqual({
      type: "resume",
      seat: expect.objectContaining({ index: 0, playerName: "阿黄" }),
    });
  });

  it("昵称去空格后匹配", () => {
    const d = decideJoin("playing", [seat({ index: 0, playerName: "阿黄", token: "t" })], "  阿黄  ");
    expect(d.type).toBe("resume");
  });

  it("对局已开始且昵称对不上", () => {
    const d = decideJoin("playing", [seat({ index: 0, playerName: "阿黄", token: "t" })], "路人");
    expect(d).toEqual({ type: "started" });
  });

  it("同名多个真人座视为歧义", () => {
    const d = decideJoin("lobby", [seat({ index: 0, playerName: "阿黄" }), seat({ index: 1, playerName: "阿黄" })], "阿黄");
    expect(d).toEqual({ type: "ambiguous" });
  });

  it("大厅没有空真人座", () => {
    const d = decideJoin("lobby", [seat({ index: 0, kind: "ai" }), seat({ index: 1, token: "t", playerName: "乙" })], "甲");
    expect(d).toEqual({ type: "full" });
  });
});

describe("decideDmJoin", () => {
  it("同名认领已占用的 DM", () => {
    expect(decideDmJoin(true, "tok", "主持人", "主持人")).toBe("resume");
  });

  it("他人已占用", () => {
    expect(decideDmJoin(true, "tok", "主持人", "路人")).toBe("taken");
  });

  it("空位可认领", () => {
    expect(decideDmJoin(true, null, null, "主持人")).toBe("claim");
  });

  it("非真人 DM 房间", () => {
    expect(decideDmJoin(false, null, null, "主持人")).toBe("not-human-dm");
  });
});

describe("gameEventsUrl", () => {
  it("观战不带座位参数", () => {
    expect(gameEventsUrl("g1", {})).toBe("/api/games/g1/events");
  });

  it("玩家带 seat/token，并从 lastSeq 续传", () => {
    expect(gameEventsUrl("g1", { seat: 2, token: "abc", lastSeq: "42" })).toBe(
      "/api/games/g1/events?seat=2&token=abc&lastSeq=42"
    );
  });

  it("lastSeq 为 0 时不写入，避免整段重放语义被干扰", () => {
    expect(gameEventsUrl("g1", { seat: 0, token: "t", lastSeq: "0" })).toBe("/api/games/g1/events?seat=0&token=t");
  });

  it("DM 视角", () => {
    expect(gameEventsUrl("g1", { dm: true, dmToken: "d", lastSeq: "9" })).toBe(
      "/api/games/g1/events?dm=1&dmtoken=d&lastSeq=9"
    );
  });
});
