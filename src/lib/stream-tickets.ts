import crypto from "node:crypto";

/**
 * SSE 一次性票据（S3.5）：座位 / DM 的长期 token 不再进 SSE 的 URL（会落进访问日志），
 * 改为先用 header 里的 token 换一张 60 秒、用后即弃的 ticket，再把 ticket 放进订阅地址。
 *
 * 存储是进程内的（与引擎实例、限流桶同一前提：单实例部署）。票据本身不是凭证的替身，
 * 签发时把已验证的 token 一并留在连接作用域里（`StreamPrincipal.credential`），
 * 心跳重验仍然拿它和库里的当前 token 比——轮换凭证照样能在一个心跳周期内断开旧连接。
 */

export const STREAM_TICKET_TTL_MS = 60_000;

export type StreamPrincipal =
  | { kind: "seat"; seat: number; credential: string }
  | { kind: "dm"; credential: string };

type TicketRecord = { gameId: string; principal: StreamPrincipal; expiresAt: number };

const tickets = new Map<string, TicketRecord>();

/** 过期就删：签发时顺带清扫，避免只换不用的票据长期占内存。 */
function sweepExpired(now: number): void {
  for (const [ticket, rec] of tickets) {
    if (rec.expiresAt <= now) tickets.delete(ticket);
  }
}

export function issueStreamTicket(
  gameId: string,
  principal: StreamPrincipal,
  now = Date.now()
): { ticket: string; expiresAt: number } {
  sweepExpired(now);
  const ticket = crypto.randomBytes(16).toString("hex");
  const expiresAt = now + STREAM_TICKET_TTL_MS;
  tickets.set(ticket, { gameId, principal, expiresAt });
  return { ticket, expiresAt };
}

/**
 * 取出并作废票据（一次性）。过期、重复使用、跨局使用一律返回 null —— 调用方按
 * 「未通过鉴权」处理，与旧的错误 token 同样降级为纯观战，不回具体原因。
 */
export function consumeStreamTicket(gameId: string, ticket: string | null, now = Date.now()): StreamPrincipal | null {
  if (!ticket) return null;
  const rec = tickets.get(ticket);
  if (!rec) return null;
  tickets.delete(ticket);
  if (rec.expiresAt <= now) return null;
  if (rec.gameId !== gameId) return null;
  return rec.principal;
}

/** 仅供测试与运维排查复位。 */
export function resetStreamTickets(): void {
  tickets.clear();
}
