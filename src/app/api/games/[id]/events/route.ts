import { db } from "@/lib/db";
import { subscribe } from "@/core/engine/bus";
import type { BusMessage, EngineEvent } from "@/core/engine/types";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function visibleTo(event: EngineEvent, seatIndex: number | null): boolean {
  if (event.visibility === "public") return true;
  if (seatIndex === null) return false;
  if (event.visibility === `seat:${seatIndex}`) return true;
  return false;
}

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
    content: r.content as EngineEvent["content"],
    createdAt: r.createdAt.toISOString(),
  };
}

/** SSE 事件流。查询参数：seat（座位号，缺省为纯观战）。支持 Last-Event-ID 断线续传。 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const seatParam = url.searchParams.get("seat");
  const lastSeqHeader = req.headers.get("last-event-id");
  const lastSeq = BigInt(lastSeqHeader ?? url.searchParams.get("lastSeq") ?? "0");

  const game = await db.game.findUnique({ where: { id }, include: { room: { include: { seats: true } } } });
  if (!game) return new Response("game not found", { status: 404 });

  // 座位视角需要 token 鉴权；失败则降级为纯观战（仅公开事件）
  let seatIndex: number | null = seatParam !== null && seatParam !== "" ? Number(seatParam) : null;
  if (seatIndex !== null) {
    const seatRow = game.room.seats.find((s) => s.index === seatIndex);
    const token = url.searchParams.get("token");
    if (!seatRow?.token || seatRow.token !== token) seatIndex = null;
  }
  // 真人 DM 视角：可见全部事件（含所有座位私发内容）。DM 未认领时一律不授权。
  const dmView =
    url.searchParams.get("dm") === "1" &&
    game.room.humanDm &&
    !!game.room.dmToken &&
    game.room.dmToken === url.searchParams.get("dmtoken");

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

      // 1) 补发历史事件（> lastSeq，按视角过滤）
      const history = await db.gameEvent.findMany({ where: { gameId: id, seq: { gt: lastSeq } }, orderBy: { seq: "asc" } });
      for (const row of history) {
        const ev = rowToEvent(row);
        if (dmView || visibleTo(ev, seatIndex)) send({ kind: "event", event: ev }, ev.seq);
      }
      send({ kind: "hello", lastSeq: history.length ? history[history.length - 1].seq.toString() : lastSeq.toString() });

      // 2) 订阅总线
      unsubscribe = subscribe(id, (msg: BusMessage) => {
        if (msg.kind === "event") {
          if (!dmView && !visibleTo(msg.event, seatIndex)) return;
          send(msg, msg.event.seq);
        } else if (msg.kind === "delta" || msg.kind === "thinking") {
          if (msg.audience !== "public" && !dmView && seatIndex !== msg.audience) return;
          send(msg);
        } else {
          send(msg);
        }
      });

      // 3) 心跳保活
      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            closed = true;
          }
        }
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
