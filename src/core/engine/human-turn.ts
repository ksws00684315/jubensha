import { needsHumanDeadline } from "@/lib/human-timeout";
import { HUMAN_TURN_TIMEOUT_MS } from "./util";
import type { GameEngine } from "./engine";

/**
 * 真人回合限时（批次 I1 自 engine.ts 拆出）：
 * 限时模式的目的是"真人挂机不卡住流程"——挂定时器 + 记录截止时间（前端倒计时读 state.humanDeadlines）。
 */

export async function armHumanTimeout(e: GameEngine, seat: number, label: string, auto?: () => Promise<void>): Promise<void> {
  if (e.unlimitedHumanTurns) return;
  e.state.humanDeadlines ??= {};
  e.state.humanDeadlines[String(seat)] = Date.now() + HUMAN_TURN_TIMEOUT_MS;
  // 先落库再提示：紧跟其后的「轮到你」事件会触发前端刷新概要，必须能读到截止时间
  await e.persist();
  e.schedule(`human-turn:${seat}`, async () => {
    clearHumanTimeout(e, seat);
    await e.persist();
    await e.systemSay(
      `（你已超过 3 分钟未操作，${auto ? `${label}已由系统自动处理。` : "本轮发言已自动跳过。"}）`,
      seat,
      { timeoutSkip: true }
    );
    await e.systemSay(
      `（超时提醒：${label}环节等待「${e.state.seats[seat]?.playerName ?? `座位${seat + 1}`}」已超过 3 分钟${auto ? "，已自动处理。" : "，已自动跳过。"}）`
    );
    if (auto) {
      await auto();
      return;
    }
    if (e.state.phase === "SELF_INTRO" || e.state.phase === "DISCUSSION") {
      e.markSpoken(seat);
      await e.nextTurnOrAdvance();
    } else {
      await e.tickInner();
    }
  }, HUMAN_TURN_TIMEOUT_MS);
}

/**
 * 确保该座位此刻存在有效的超时截止时间。
 *
 * 限时模式的目的是"真人挂机不卡住流程"，但「提问」会刻意清掉提问者的定时器
 * （提问本身就证明在参与）。若回到提问者回合时只依赖 turnAsked 记忆位，
 * 就不会重新武装——对方作答后提问者挂机将永久停在讨论环节。
 * 因此一律以「截止时间是否存在」为判据，而不是「是否已经提示过」。
 */
export async function ensureHumanTimeout(e: GameEngine, seat: number, label: string): Promise<void> {
  if (e.unlimitedHumanTurns) return;
  if (!needsHumanDeadline(e.state.humanDeadlines, seat)) return;
  await armHumanTimeout(e, seat, label);
}

/** 真人行动到达时解除限时：清定时器 + 清截止时间（调用点随后都会 persistState）。 */
export function clearHumanTimeout(e: GameEngine, seat: number): void {
  e.clearTimers(`human-turn:${seat}`);
  if (e.state.humanDeadlines) delete e.state.humanDeadlines[String(seat)];
}
