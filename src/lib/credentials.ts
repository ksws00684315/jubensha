import { safeEqualString } from "@/lib/admin";

/**
 * 凭证比对原语。任一侧为空（null / undefined / ""）一律算不匹配 —— 不能让「双方都没发凭证」
 * 被当成认证通过。非空时走常量时间比较，避免用响应时间逐字节猜 token。
 */
export function verifyToken(presented: string | null | undefined, stored: string | null | undefined): boolean {
  if (!presented || !stored) return false;
  return safeEqualString(presented, stored);
}

export type SeatCredential = { index: number; token: string | null };

/** 座位凭证：座位存在、已发放过 token，且 presented 与之匹配。 */
export function verifySeatToken(
  seats: SeatCredential[],
  index: number | null | undefined,
  presented: string | null | undefined
): boolean {
  if (index === null || index === undefined) return false;
  return verifyToken(presented, seats.find((s) => s.index === index)?.token);
}

/**
 * 真人主持凭证。只管「这个 token 是不是这房间的 DM token」，不含 humanDm 开关判断 ——
 * 是否启用真人主持模式由各调用点自行决定（观战授权路径本来就不看 humanDm）。
 */
export function verifyDmToken(room: { dmToken: string | null }, presented: string | null | undefined): boolean {
  return verifyToken(presented, room.dmToken);
}

/** 房主凭证 */
export function verifyHostToken(room: { hostToken: string | null }, presented: string | null | undefined): boolean {
  return verifyToken(presented, room.hostToken);
}
