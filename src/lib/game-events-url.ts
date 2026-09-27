/**
 * SSE 订阅地址。凭证只能走 query——EventSource 不支持自定义请求头；
 * 其余 REST 调用已迁到 x-seat-token / x-dm-token 头（避免 token 进访问日志）。
 *
 * 单独成模块是因为 join.ts 需要引用服务端的凭证比对（credentials → node:crypto），
 * 而这个函数跑在浏览器里：两者同文件会让客户端构建直接失败。
 */
export function gameEventsUrl(
  gameId: string,
  opts: { seat?: number | null; token?: string | null; dm?: boolean; dmToken?: string | null; lastSeq?: string }
): string {
  const q = new URLSearchParams();
  if (opts.dm) {
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
