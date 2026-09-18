/**
 * 极简内存限流。
 *
 * 用途：入局接口只需要「5 位房间码」就能尝试（`seeds` 之外的凭证都不需要），
 * 24⁵ ≈ 8e6 的组合在无限速时可被在线枚举/抢占真人座位。
 * 本应用是单实例部署（引擎状态就在内存里，不支持多副本），所以进程内计数天然适用。
 *
 * 局限（如实说明）：`x-forwarded-for` 由客户端可伪造，直接暴露在局域网时攻击者可以靠轮换
 * 该头绕过按 IP 的桶——因此这里额外加了一个全局桶做兜底。要真正扛住公网滥用，
 * 应把服务收到 127.0.0.1 并交给反向代理，由反代做连接级限流。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
/** 桶数量上限：短时间涌入大量不同 key（例如轮换 XFF）时不至于把内存吃光 */
const MAX_BUCKETS = 5000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (!oldest) break;
    // 全局桶是跨来源的最后一道保护，永不因单个来源灌入而被删除。
    if (oldest.endsWith(":global")) {
      const next = buckets.keys();
      next.next();
      const candidate = next.next().value as string | undefined;
      if (!candidate) break;
      buckets.delete(candidate);
    } else {
      buckets.delete(oldest);
    }
  }
}

/** 固定窗口计数：窗口内第 limit+1 次请求被拒。 */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfterMs: number } {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > MAX_BUCKETS) sweep(now);
    return { ok: true, retryAfterMs: 0 };
  }
  if (bucket.count >= limit) return { ok: false, retryAfterMs: bucket.resetAt - now };
  bucket.count += 1;
  return { ok: true, retryAfterMs: 0 };
}

/** 仅供测试与运维排查复位。 */
export function resetRateLimits(): void {
  buckets.clear();
}

/** 客户端 IP：反代场景取 XFF 首跳，直连场景取 x-real-ip，都拿不到时归为同一桶。 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || req.headers.get("x-real-ip")?.trim() || "unknown";
}

const JOIN_WINDOW_MS = 60_000;
const JOIN_LIMIT_PER_IP = 10;
const JOIN_LIMIT_GLOBAL = 60;
const ROOM_WINDOW_MS = 60_000;
const ROOM_LIMIT_PER_IP = 60;
const ROOM_LIMIT_GLOBAL = 300;

/** 入局接口统一策略：同 IP 10 次/分钟，全局 60 次/分钟兜底。 */
export function checkJoinRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const perIp = rateLimit(`join:ip:${clientIp(req)}`, JOIN_LIMIT_PER_IP, JOIN_WINDOW_MS);
  if (!perIp.ok) return { ok: false, retryAfterSec: Math.ceil(perIp.retryAfterMs / 1000) };
  const global = rateLimit("join:global", JOIN_LIMIT_GLOBAL, JOIN_WINDOW_MS);
  if (!global.ok) return { ok: false, retryAfterSec: Math.ceil(global.retryAfterMs / 1000) };
  return { ok: true };
}

/** 大厅状态轮询需要比入局更宽的配额，但仍不能无限枚举房间。 */
export function checkRoomRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const perIp = rateLimit(`room:ip:${clientIp(req)}`, ROOM_LIMIT_PER_IP, ROOM_WINDOW_MS);
  if (!perIp.ok) return { ok: false, retryAfterSec: Math.ceil(perIp.retryAfterMs / 1000) };
  const global = rateLimit("room:global", ROOM_LIMIT_GLOBAL, ROOM_WINDOW_MS);
  if (!global.ok) return { ok: false, retryAfterSec: Math.ceil(global.retryAfterMs / 1000) };
  return { ok: true };
}

/** 建房：垃圾房间会永久占库，按 IP 5 个/分钟、全局 60 个/分钟。 */
export function checkCreateRoomRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const perIp = rateLimit(`create:ip:${clientIp(req)}`, 5, 60_000);
  if (!perIp.ok) return { ok: false, retryAfterSec: Math.ceil(perIp.retryAfterMs / 1000) };
  const global = rateLimit("create:global", 60, 60_000);
  if (!global.ok) return { ok: false, retryAfterSec: Math.ceil(global.retryAfterMs / 1000) };
  return { ok: true };
}

/** 游戏动作：正常玩家每分钟远达不到 60 次；按 IP 计是为挡住脚本化的批量轰击。 */
export function checkActionRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const perIp = rateLimit(`action:ip:${clientIp(req)}`, 60, 60_000);
  if (!perIp.ok) return { ok: false, retryAfterSec: Math.ceil(perIp.retryAfterMs / 1000) };
  const global = rateLimit("action:global", 1200, 60_000);
  if (!global.ok) return { ok: false, retryAfterSec: Math.ceil(global.retryAfterMs / 1000) };
  return { ok: true };
}

/** TTS 合成：外部合成服务按量计费，凭证校验通过后仍要有频控。 */
export function checkTtsRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const perIp = rateLimit(`tts:ip:${clientIp(req)}`, 20, 60_000);
  if (!perIp.ok) return { ok: false, retryAfterSec: Math.ceil(perIp.retryAfterMs / 1000) };
  const global = rateLimit("tts:global", 120, 60_000);
  if (!global.ok) return { ok: false, retryAfterSec: Math.ceil(global.retryAfterMs / 1000) };
  return { ok: true };
}
