/** 真人限时倒计时：最后 60 秒才在行动区出现，提前出现反而催促过度。 */
export const COUNTDOWN_WINDOW_MS = 60_000;

/** 剩余时间在 (0, 60s] 窗口内才返回剩余毫秒，否则 null（不显示倒计时）。 */
export function countdownRemaining(deadline: number | null | undefined, now: number): number | null {
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return null;
  const left = deadline - now;
  return left > 0 && left <= COUNTDOWN_WINDOW_MS ? left : null;
}

/** 秒级向上取整展示，窗口起点显示「60 秒」而不是「59 秒」。 */
export function formatCountdown(leftMs: number): string {
  return `${Math.ceil(leftMs / 1000)} 秒`;
}
