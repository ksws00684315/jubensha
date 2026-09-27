import { withRoute } from "@/lib/api";
import { db } from "@/lib/db";
import { subscribe } from "@/core/engine/bus";
import type { BusMessage, EngineEvent } from "@/core/engine/types";
import type { Prisma } from "@prisma/client";
import { sanitizeEventContent, visibleTo } from "@/core/engine/state";
import { GameEngine } from "@/core/engine/engine";
import { verifyDmToken, verifySeatToken } from "@/lib/credentials";
import { consumeStreamTicket } from "@/lib/stream-tickets";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function rowToEvent(r: {
  seq: bigint;
  type: string;
  phase: string;
  round: number;
  fromSeat: number | null;
  toSeat: number | null;
  visibility: string;
  content: Prisma.JsonValue;
  createdAt: Date;
}): EngineEvent {
  return {
    seq: r.seq.toString(),
    type: r.type as EngineEvent["type"],
    phase: r.phase as EngineEvent["phase"],
    round: r.round,
    fromSeat: r.fromSeat,
    toSeat: r.toSeat,
    visibility: r.visibility,
    content: sanitizeEventContent(r.content as Record<string, unknown>) as EngineEvent["content"],
    createdAt: r.createdAt.toISOString(),
  };
}

/** 兼容期告警：只记「走了旧凭证方式 + 是哪个视角」，token 明文一律不入日志（硬性不变式 5）。 */
function warnLegacyCredential(gameId: string, view: string): void {
  console.warn(
    `[sse] ${gameId} 使用已废弃的 query 凭证（${view}），token 会进访问日志；` +
      `请改用 POST /api/games/${gameId}/stream-ticket 换取一次性 ticket。此兼容路径保留一个版本。`
  );
}

/** SSE 事件流。查询参数：ticket（首选，见 stream-tickets）或兼容期的 seat/token/dm/dmtoken。支持 Last-Event-ID 断线续传。 */
async function GET_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const seatParam = url.searchParams.get("seat");
  const lastSeqHeader = req.headers.get("last-event-id");
  let lastSeq: bigint;
  try {
    lastSeq = BigInt(lastSeqHeader ?? url.searchParams.get("lastSeq") ?? "0");
  } catch {
    // 损坏/伪造的 Last-Event-ID：降级为从头重放（前端按 seq 去重），不能让流挂掉
    lastSeq = BigInt(0);
  }

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: true } } } });
  if (!game) return new Response("game not found", { status: 404 });

  // 视角与凭证：鉴权失败一律降级为纯观战（仅公开事件），不回具体原因。
  // 带 ticket 时视角是签发那一刻定死在票据里的；ticket 已被消费，心跳不能再去 URL 里读它，
  // 所以把当时验证过的凭证留在连接作用域内（seatCredential / dmCredential）当比对基准。
  let seatIndex: number | null = null;
  let seatCredential: string | null = null;
  let dmCredential: string | null = null;
  const ticketParam = url.searchParams.get("ticket");
  if (ticketParam) {
    const principal = consumeStreamTicket(id, ticketParam);
    if (!principal) {
      // 有 ticket 参数就以 ticket 为准，不再回落到 query 里的旧凭证
      console.warn(`[sse] ${id} ticket 无效（过期 / 重复使用 / 跨局），降级为纯观战`);
    } else if (principal.kind === "seat") {
      seatIndex = principal.seat;
      seatCredential = principal.credential;
    } else {
      dmCredential = principal.credential;
    }
  } else {
    seatIndex = seatParam !== null && seatParam !== "" ? Number(seatParam) : null;
    seatCredential = url.searchParams.get("token");
    if (url.searchParams.get("dm") === "1") dmCredential = url.searchParams.get("dmtoken");
  }
  if (!verifySeatToken(game.room.seats, seatIndex, seatCredential)) {
    seatIndex = null;
    seatCredential = null;
  } else if (!ticketParam) {
    warnLegacyCredential(id, `座位 ${seatIndex}`);
  }
  // 真人 DM 视角：可见全部事件（含所有座位私发内容）。DM 未认领时一律不授权。
  const dmView = !!dmCredential && !!game.room.humanDm && verifyDmToken(game.room, dmCredential);
  if (dmView && !ticketParam) warnLegacyCredential(id, "真人主持");
  if (!dmView) dmCredential = null;

  // 公开 SSE 只能回放事件，不得触发 AI。持有座位或 DM 凭证时才允许懒恢复。
  if (game.status === "running" && (seatIndex !== null || dmView) && !GameEngine.get(id)) {
    void GameEngine.load(id).catch(() => null);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown, eventId?: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${eventId ? `id: ${eventId}\n` : ""}data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // 先订阅再查询历史，避免查询与订阅之间产生事件丢失。
      // 历史查询期间暂存实时事件，回放完成后按序发送并去重。
      const delivered = new Set<string>();
      const pending: EngineEvent[] = [];
      const pendingEnds: Extract<BusMessage, { kind: "end" }>[] = [];
      let replaying = true;
      const sendEvent = (ev: EngineEvent) => {
        if (delivered.has(ev.seq)) return;
        delivered.add(ev.seq);
        if (dmView || visibleTo(ev, seatIndex)) send({ kind: "event", event: ev }, ev.seq);
      };
      unsubscribe = subscribe(id, (msg: BusMessage) => {
        if (msg.kind === "event") {
          if (replaying) pending.push(msg.event);
          else sendEvent(msg.event);
        } else if (msg.kind === "delta" || msg.kind === "thinking") {
          if (msg.audience !== "public" && !dmView && seatIndex !== msg.audience) return;
          send(msg);
        } else if (msg.kind === "end" && replaying) {
          pendingEnds.push(msg);
        } else {
          send(msg);
        }
      });

      // 1) 补发历史事件（> lastSeq，按视角过滤）。查询失败只放弃回放、保住实时订阅，
      // 避免 start() 抛错让 unsubscribe 已建立的订阅泄漏。
      let history: Awaited<ReturnType<typeof db.gameEvent.findMany>> = [];
      try {
        history = await db.gameEvent.findMany({ where: { gameId: id, seq: { gt: lastSeq } }, orderBy: { seq: "asc" } });
      } catch (err) {
        console.error(`[sse] ${id} 历史回放失败，仅保留实时流：${String(err)}`);
      }
      for (const row of history) {
        sendEvent(rowToEvent(row));
      }
      replaying = false;
      pending.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
      for (const ev of pending) sendEvent(ev);
      const lastDelivered = history.length ? history[history.length - 1].seq.toString() : lastSeq.toString();
      send({ kind: "hello", lastSeq: lastDelivered });
      for (const end of pendingEnds) send(end);

      // 2) 心跳保活 + 定期重验凭证（座位/DM token 轮换后,旧订阅随之失效）
      heartbeat = setInterval(() => {
        if (closed) return;
        void (async () => {
          try {
            const fresh = await db.game.findUnique({
              where: { id },
              select: { room: { select: { seats: { select: { index: true, token: true } }, dmToken: true, humanDm: true } } },
            });
            const stillValid =
              !!fresh &&
              (seatIndex === null || verifySeatToken(fresh.room.seats, seatIndex, seatCredential)) &&
              (!dmView || (fresh.room.humanDm && verifyDmToken(fresh.room, dmCredential)));
            if (!stillValid) {
              closed = true;
              unsubscribe?.();
              if (heartbeat) clearInterval(heartbeat);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
              return;
            }
          } catch {
            /* 查询失败不断开,下个心跳再试 */
          }
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              closed = true;
            }
          }
        })();
      }, 20_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export const GET = withRoute(GET_IMPL);
