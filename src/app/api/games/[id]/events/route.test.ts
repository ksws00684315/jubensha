import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDbInstance } from "@/test/api";
import { db } from "@/lib/db";
import { GameEngine } from "@/core/engine/engine";
import { publish } from "@/core/engine/bus";
import type { EngineEvent } from "@/core/engine/types";

vi.mock("@/lib/db", () => ({ db: mockDbInstance }));
// 路由只需 get/load 判定懒恢复；真引擎模块图（LLM/定时器）与 SSE 测试无关
vi.mock("@/core/engine/engine", () => ({
  GameEngine: { get: vi.fn(() => null), load: vi.fn(async () => ({})) },
}));

const mockFindGame = vi.mocked(db.game.findUnique);
const mockFindEvents = vi.mocked(db.gameEvent.findMany);
const mockEngineLoad = vi.mocked(GameEngine.load);

const GAME_ID = "sse-game-1";

function gameRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GAME_ID,
    status: "running",
    room: { humanDm: false, dmToken: null, seats: [{ index: 0, token: "tok-0" }, { index: 1, token: "tok-1" }] },
    ...overrides,
  };
}

function row(seq: number, patch: Record<string, unknown> = {}) {
  return {
    seq: BigInt(seq),
    type: "speech",
    phase: "DISCUSSION",
    round: 1,
    fromSeat: 1,
    toSeat: null,
    visibility: "public",
    content: { text: `E${seq}`, speakerName: "周伯" },
    createdAt: new Date("2026-09-18T21:00:00Z"),
    ...patch,
  };
}

function busEvent(seq: string, patch: Partial<EngineEvent> = {}): EngineEvent {
  return {
    seq,
    type: "speech",
    phase: "DISCUSSION",
    round: 1,
    fromSeat: 1,
    toSeat: null,
    visibility: "public",
    content: { text: `B${seq}`, speakerName: "周伯" },
    createdAt: "2026-09-18T21:00:00.000Z",
    ...patch,
  };
}

/** 建流并后台解析 SSE 帧；abort() 断开以清理心跳与订阅。 */
async function openStream(query: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const { GET } = await import("./route");
  const req = new Request(`http://localhost/api/games/${GAME_ID}/events${query}`, { headers, signal: ac.signal });
  const res = await GET(req, { params: Promise.resolve({ id: GAME_ID }) });
  const msgs: Record<string, unknown>[] = [];
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const m = frame.match(/^data: (.*)$/m);
          if (m) {
            msgs.push(JSON.parse(m[1]));
          }
        }
      }
    })().catch(() => undefined);
    const waitFor = async (pred: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`SSE 超时，已收到：${JSON.stringify(msgs)}`);
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    };
    return { res, msgs, waitFor, abort: () => ac.abort() };
  }
  return { res, msgs, waitFor: async () => undefined, abort: () => ac.abort() };
}

const seqsOf = (msgs: Record<string, unknown>[]) => msgs.filter((m) => m.kind === "event").map((m) => (m.event as EngineEvent).seq);

describe("events SSE：回放 / 鉴权降级 / 断线续传", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindGame.mockResolvedValue(gameRow() as never);
    mockFindEvents.mockResolvedValue([] as never);
  });

  it("对局不存在时 404", async () => {
    mockFindGame.mockResolvedValueOnce(null as never);
    const { res } = await openStream("");
    expect(res.status).toBe(404);
  });

  it("按 lastSeq 增量回放并以 hello 收尾；观战流不触发引擎懒恢复", async () => {
    mockFindEvents.mockResolvedValue([row(6)] as never);
    const { msgs, waitFor, abort } = await openStream("?lastSeq=5");
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    expect(mockFindEvents).toHaveBeenCalledWith(expect.objectContaining({ where: { gameId: GAME_ID, seq: { gt: BigInt(5) } } }));
    expect(seqsOf(msgs)).toEqual(["6"]);
    expect((msgs.find((m) => m.kind === "hello") as { lastSeq: string }).lastSeq).toBe("6");
    expect(mockEngineLoad).not.toHaveBeenCalled(); // 无凭证：只回放，不唤醒 AI
    abort();
  });

  it("座位 token 无效 → 降级纯观战，私有事件不外泄", async () => {
    mockFindEvents.mockResolvedValue([row(6), row(7, { visibility: "seat:0", content: { text: "私密" } })] as never);
    const { msgs, waitFor, abort } = await openStream("?seat=0&token=wrong&lastSeq=0");
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    expect(seqsOf(msgs)).toEqual(["6"]);
    expect(JSON.stringify(msgs)).not.toContain("私密");
    expect(mockEngineLoad).not.toHaveBeenCalled();
    abort();
  });

  it("座位 token 有效 → 收到私发事件并懒恢复引擎", async () => {
    mockFindEvents.mockResolvedValue([row(6), row(7, { visibility: "seat:0", content: { text: "私密" } })] as never);
    const { msgs, waitFor, abort } = await openStream("?seat=0&token=tok-0&lastSeq=0");
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    expect(seqsOf(msgs)).toEqual(["6", "7"]);
    expect(mockEngineLoad).toHaveBeenCalledWith(GAME_ID);
    abort();
  });

  it("断线重连：Last-Event-ID 头优先续传；伪造头降级全量回放不挂流", async () => {
    mockFindEvents.mockResolvedValue([row(6)] as never);
    const good = await openStream("?lastSeq=0", { "last-event-id": "5" });
    await good.waitFor(() => good.msgs.some((m) => m.kind === "hello"));
    expect(mockFindEvents).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ seq: { gt: BigInt(5) } }) }));
    expect(seqsOf(good.msgs)).toEqual(["6"]);
    good.abort();

    const forged = await openStream("", { "last-event-id": "not-a-bigint!!" });
    await forged.waitFor(() => forged.msgs.some((m) => m.kind === "hello"));
    expect(mockFindEvents).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ seq: { gt: BigInt(0) } }) }));
    expect(seqsOf(forged.msgs)).toEqual(["6"]); // 从头重放，前端按 seq 去重
    forged.abort();
  });

  it("历史查询期间总线推来事件：缓冲合并、按 seq 排序且去重不重发", async () => {
    let resolveHistory: (rows: unknown[]) => void = () => undefined;
    mockFindEvents.mockImplementationOnce(() => new Promise((res) => { resolveHistory = res; }) as never);
    const { msgs, waitFor, abort } = await openStream("?lastSeq=0");
    // start() 在 GET 返回前已同步完成订阅，此刻历史查询仍挂着
    publish(GAME_ID, { kind: "event", event: busEvent("7") });
    publish(GAME_ID, { kind: "event", event: busEvent("6") });
    resolveHistory([row(6)] as never[]);
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    expect(seqsOf(msgs)).toEqual(["6", "7"]); // 6 与历史重叠只发一次；pending 按 seq 升序
    publish(GAME_ID, { kind: "event", event: busEvent("6") });
    await new Promise((r) => setTimeout(r, 50));
    expect(seqsOf(msgs).filter((s) => s === "6")).toHaveLength(1); // 回放后重发同 seq 也被 delivered 去重
    abort();
  });

  it("delta/thinking 按 audience 过滤：他人定向流不进本席", async () => {
    const { msgs, waitFor, abort } = await openStream("?seat=0&token=tok-0&lastSeq=0");
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    publish(GAME_ID, { kind: "delta", seat: 1, text: "公开直播中的台词", audience: "public" });
    publish(GAME_ID, { kind: "delta", seat: 1, text: "发给1号的草稿", audience: 1 });
    publish(GAME_ID, { kind: "delta", seat: 1, text: "发给0号的草稿", audience: 0 });
    await waitFor(() => msgs.filter((m) => m.kind === "delta").length === 2);
    const deltas = msgs.filter((m) => m.kind === "delta").map((m) => m.text);
    expect(deltas).toEqual(["公开直播中的台词", "发给0号的草稿"]);
    abort();
  });

  it("真人主持凭证正确时可见全部私有事件", async () => {
    mockFindGame.mockResolvedValueOnce(
      { id: GAME_ID, status: "running", room: { humanDm: true, dmToken: "dm-1", seats: [{ index: 0, token: "tok-0" }] } } as never
    );
    mockFindEvents.mockResolvedValueOnce([row(7, { visibility: "seat:0", content: { text: "私密" } })] as never);
    const { msgs, waitFor, abort } = await openStream("?dm=1&dmtoken=dm-1&lastSeq=0");
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    expect(seqsOf(msgs)).toEqual(["7"]);
    abort();
  });

  it("结束通知携带最终事件序号", async () => {
    const { msgs, waitFor, abort } = await openStream("?lastSeq=0");
    await waitFor(() => msgs.some((m) => m.kind === "hello"));
    publish(GAME_ID, { kind: "end", lastEventSeq: "42" });
    await waitFor(() => msgs.some((m) => m.kind === "end"));
    expect(msgs.find((m) => m.kind === "end")).toEqual({ kind: "end", lastEventSeq: "42" });
    abort();
  });

  it("历史回放期间结束通知排在复盘、揭晓和 ENDED 事件之后", async () => {
    let resolveHistory: (rows: unknown[]) => void = () => undefined;
    mockFindEvents.mockImplementationOnce(() => new Promise((resolve) => { resolveHistory = resolve; }) as never);
    const { msgs, waitFor, abort } = await openStream("?lastSeq=0");
    publish(GAME_ID, { kind: "event", event: busEvent("6", { type: "phase", phase: "REVEAL", content: { text: "主持复盘", phase: "REVEAL" } }) });
    publish(GAME_ID, { kind: "event", event: busEvent("7", { type: "reveal", phase: "REVEAL", content: { text: "结构化揭晓" } }) });
    publish(GAME_ID, { kind: "event", event: busEvent("8", { type: "phase", phase: "ENDED", content: { text: "", phase: "ENDED" } }) });
    publish(GAME_ID, { kind: "end", lastEventSeq: "8" });
    resolveHistory([]);

    await waitFor(() => msgs.some((m) => m.kind === "end"));
    expect(seqsOf(msgs)).toEqual(["6", "7", "8"]);
    expect(msgs.findIndex((m) => m.kind === "end")).toBeGreaterThan(msgs.findIndex((m) => m.kind === "event" && (m.event as EngineEvent).type === "phase" && (m.event as EngineEvent).phase === "ENDED"));
    expect((msgs.find((m) => m.kind === "end") as { lastEventSeq: string }).lastEventSeq).toBe("8");
    abort();
  });
});
