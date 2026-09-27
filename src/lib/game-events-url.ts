/**
 * SSE 订阅地址。EventSource 不支持自定义请求头，所以凭证只能放 query ——
 * 放的是 60 秒一次性的 ticket（先经 `POST /api/games/[id]/stream-ticket` 用 header 里的 token 换来），
 * 这样落进访问日志的只是一次性票据，不是座位 / 主持的长期 token。
 *
 * `token` 与 `dmToken` 是兼容期的旧参数（服务端会记 deprecation 日志，保留一个版本后删除）。
 * 其余 REST 调用已迁到 x-seat-token / x-dm-token 头（避免 token 进访问日志）。
 *
 * 单独成模块是因为 join.ts 需要引用服务端的凭证比对（credentials → node:crypto），
 * 而这个函数跑在浏览器里：两者同文件会让客户端构建直接失败。
 */
export function gameEventsUrl(
  gameId: string,
  opts: {
    seat?: number | null;
    token?: string | null;
    dm?: boolean;
    dmToken?: string | null;
    ticket?: string | null;
    lastSeq?: string;
  }
): string {
  const q = new URLSearchParams();
  if (opts.ticket) {
    // 视角在换票时就定死在票据里了，URL 不需要再声明 seat / dm
    q.set("ticket", opts.ticket);
  } else if (opts.dm) {
    q.set("dm", "1");
    if (opts.dmToken) q.set("dmtoken", opts.dmToken);
  } else if (opts.seat != null && opts.token) {
    q.set("seat", String(opts.seat));
    q.set("token", opts.token);
  }
  if (opts.lastSeq && opts.lastSeq !== "0") q.set("lastSeq", opts.lastSeq);
  const s = q.toString();
  return `/api/games/${gameId}/events${s ? `?${s}` : ""}`;
}
