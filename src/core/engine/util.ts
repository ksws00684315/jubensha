/** engine 子模块共享的小工具（从 engine.ts 下沉，避免模块间互相 import 运行时循环）。 */

export function msgOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** 事件序号（BigInt 字符串）比较：a 是否比 b 新 */
export function isNewerSeq(a: string | undefined, b: string | undefined): boolean {
  return BigInt(a ?? "0") > BigInt(b ?? "0");
}

export async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("AI 决策超时")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** AI 回合看门狗/决策超时的统一口径（原 engine.ts 顶部常量）。 */
export const HUMAN_TURN_TIMEOUT_MS = 180_000;
export const AI_DECISION_TIMEOUT_MS = 90_000;
