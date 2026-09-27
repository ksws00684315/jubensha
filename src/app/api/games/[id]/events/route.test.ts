import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDbInstance } from "@/test/api";
import { db } from "@/lib/db";
import { GameEngine } from "@/core/engine/engine";
import { publish } from "@/core/engine/bus";
import type { EngineEvent } from "@/core/engine/types";
import { issueStreamTicket, resetStreamTickets, STREAM_TICKET_TTL_MS } from "@/lib/stream-tickets";

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

/** 建流并后台解析 SSE 帧；abort() 断开以清理心跳与订阅。isEnded() 读服务端是否已主动收流。 */
async function openStream(query: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const { GET } = await import("./route");
  const req = new Request(`http://localhost/api/games/${GAME_ID}/events${query}`, { headers, signal: ac.signal });
  const res = await GET(req, { params: Promise.resolve({ id: GAME_ID }) });
  const msgs: Record<string, unknown>[] = [];
  let ended = false;
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
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
    return { res, msgs, waitFor, isEnded: () => ended, abort: () => ac.abort() };
  }
  return { res, msgs, waitFor: async () => undefined, isEnded: () => ended, abort: () => ac.abort() };
}

const seqsOf = (msgs: Record<string, unknown>[]) => msgs.filter((m) => m.kind === "event").map((m) => (m.event as EngineEvent).seq);

describe("A29 GET /api/games/[id]/events（SSE）：回放 / 鉴权降级 / 断线续传", () => {
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

  it("R6：50 个观战 SSE 连接保持 5 分钟期间没有数据库查询", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const streams: Awaited<ReturnType<typeof openStream>>[] = [];
    const rssBefore = process.memoryUsage().rss;
    try {
      for (let i = 0; i < 50; i++) streams.push(await openStream("?lastSeq=0"));
      await vi.advanceTimersByTimeAsync(0);
      expect(streams.every((stream) => stream.msgs.some((msg) => msg.kind === "hello"))).toBe(true);
      expect(mockFindGame).toHaveBeenCalledTimes(50); // 每条流仅建连查询

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mockFindGame).toHaveBeenCalledTimes(50); // 只有每条流建连时查询一次
      expect(mockFindEvents).toHaveBeenCalledTimes(50);
      expect(streams.every((stream) => !stream.isEnded())).toBe(true);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(50 * 1024 * 1024);
    } finally {
      for (const stream of streams) stream.abort();
      vi.useRealTimers();
    }
  });

  it("匹配座位的 revoke 即时收流，其他座位不受影响", async () => {
    const seat0 = await openStream("?seat=0&token=tok-0&lastSeq=0");
    const seat1 = await openStream("?seat=1&token=tok-1&lastSeq=0");
    await Promise.all([seat0.waitFor(() => seat0.msgs.some((msg) => msg.kind === "hello")), seat1.waitFor(() => seat1.msgs.some((msg) => msg.kind === "hello"))]);

    publish(GAME_ID, { kind: "revoke", seat: 1 });
    await Promise.resolve();
    expect(seat0.isEnded()).toBe(false);
    expect(seat1.isEnded()).toBe(true);

    publish(GAME_ID, { kind: "revoke", seat: 0 });
    await Promise.resolve();
    expect(seat0.isEnded()).toBe(true);
    seat0.abort();
    seat1.abort();
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

  describe("A29 附加：ticket 建连（S3.5，长期 token 不再出现在 SSE 地址里）", () => {
    // 6=公开，7=本席私有，8=他席私有（只有真人主持可见）
    const VIEW_ROWS = () =>
      [
        row(6),
        row(7, { visibility: "seat:0", content: { text: "私密" } }),
        row(8, { visibility: "seat:1", content: { text: "他席私信" } }),
      ] as never;

    beforeEach(() => {
      resetStreamTickets();
      mockFindGame.mockResolvedValue(
        gameRow({
          room: {
            humanDm: true,
            dmToken: "dm-1",
            seats: [
              { index: 0, token: "tok-0" },
              { index: 1, token: "tok-1" },
            ],
          },
        }) as never
      );
      mockFindEvents.mockResolvedValue(VIEW_ROWS());
    });

    const seatTicket = (gameId = GAME_ID, credential = "tok-0", now = Date.now()) =>
      issueStreamTicket(gameId, { kind: "seat", seat: 0, credential }, now).ticket;

    it("有效 ticket → 本席私有事件可见且触发懒恢复；地址里没有 token", async () => {
      const query = `?${new URLSearchParams({ ticket: seatTicket(), lastSeq: "0" })}`;
      expect(query).not.toContain("token=");
      const { msgs, waitFor, abort } = await openStream(query);
      await waitFor(() => msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(msgs)).toEqual(["6", "7"]);
      expect(JSON.stringify(msgs)).not.toContain("他席私信");
      expect(mockEngineLoad).toHaveBeenCalledWith(GAME_ID);
      abort();
    });

    it("同一张 ticket 再用一次（重放攻击/重复建连）→ 降级纯观战", async () => {
      const ticket = seatTicket();
      const first = await openStream(`?${new URLSearchParams({ ticket, lastSeq: "0" })}`);
      await first.waitFor(() => first.msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(first.msgs)).toEqual(["6", "7"]);
      first.abort();

      const again = await openStream(`?${new URLSearchParams({ ticket, lastSeq: "0" })}`);
      await again.waitFor(() => again.msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(again.msgs)).toEqual(["6"]);
      expect(JSON.stringify(again.msgs)).not.toContain("私密");
      again.abort();
    });

    it("过期 ticket 与跨局 ticket 一律降级纯观战，且都不唤醒引擎", async () => {
      mockEngineLoad.mockClear();
      const expired = seatTicket(GAME_ID, "tok-0", Date.now() - STREAM_TICKET_TTL_MS);
      const expiredStream = await openStream(`?${new URLSearchParams({ ticket: expired, lastSeq: "0" })}`);
      await expiredStream.waitFor(() => expiredStream.msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(expiredStream.msgs)).toEqual(["6"]);
      expiredStream.abort();

      const otherGame = seatTicket("another-game-1");
      const crossed = await openStream(`?${new URLSearchParams({ ticket: otherGame, lastSeq: "0" })}`);
      await crossed.waitFor(() => crossed.msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(crossed.msgs)).toEqual(["6"]);
      crossed.abort();
      expect(mockEngineLoad).not.toHaveBeenCalled();
    });

    it("DM ticket 看得到他席私有；座位 ticket 混入 dm 查询参数也升不了视角", async () => {
      const dmTicket = issueStreamTicket(GAME_ID, { kind: "dm", credential: "dm-1" }, Date.now()).ticket;
      const dmStream = await openStream(`?${new URLSearchParams({ ticket: dmTicket, lastSeq: "0" })}`);
      await dmStream.waitFor(() => dmStream.msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(dmStream.msgs)).toEqual(["6", "7", "8"]);
      dmStream.abort();

      // 视角主体在签发时就写死在票据里，URL 上的 dm/dmtoken 对 ticket 连接不生效
      const seatStream = await openStream(`?${new URLSearchParams({ ticket: seatTicket(), lastSeq: "0" })}&dm=1&dmtoken=dm-1`);
      await seatStream.waitFor(() => seatStream.msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(seatStream.msgs)).toEqual(["6", "7"]);
      seatStream.abort();
    });

    it("兼容期：token query 仍可用，但记 deprecation 日志且日志不含凭证明文", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { msgs, waitFor, abort } = await openStream("?seat=0&token=tok-0&lastSeq=0");
      await waitFor(() => msgs.some((m) => m.kind === "hello"));
      expect(seqsOf(msgs)).toEqual(["6", "7"]);
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("stream-ticket");
      expect(logged).not.toContain("tok-0");
      warn.mockRestore();
      abort();
    });

    it("5 分钟心跳只发送 ping，不重新查询凭证", async () => {
      vi.useFakeTimers({ toFake: ["setInterval"] });
      try {
        const { ticket } = issueStreamTicket(GAME_ID, { kind: "seat", seat: 0, credential: "tok-0" });
        const stream = await openStream(`?${new URLSearchParams({ ticket, lastSeq: "0" })}`);
        await vi.advanceTimersByTimeAsync(0); // 让回放与 hello 的微任务跑完
        expect(seqsOf(stream.msgs)).toEqual(["6", "7"]);
        expect(stream.isEnded()).toBe(false);
        expect(mockFindGame).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(mockFindGame).toHaveBeenCalledTimes(1);
        expect(stream.isEnded()).toBe(false);
        expect(stream.msgs.filter((msg) => msg.kind === "hello")).toHaveLength(1);
        stream.abort();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
