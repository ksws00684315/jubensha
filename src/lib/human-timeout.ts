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

/**
 * 限时模式下该座位是否需要（重新）武装超时截止时间。
 *
 * 判据必须是"截止时间是否存在"，而不是"这个回合是否已经提示过"：
 * 真人提问时会刻意清掉自己的定时器（提问即证明在参与），但提问者的座位与回合都没有变，
 * 若只看"已提示过"的记忆位就不会重新武装 → 对方作答后提问者挂机再也没人跳过它，
 * tick 会永久停在 DISCUSSION（独立审查 S3）。
 */
export function needsHumanDeadline(deadlines: Record<string, number> | null | undefined, seat: number): boolean {
  return !deadlines?.[String(seat)];
}
