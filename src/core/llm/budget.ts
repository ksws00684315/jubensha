import { db } from "@/lib/db";
import { log } from "@/lib/log";

/** 当日 token 预算已耗尽。调用方不需要单独 catch：引擎沿用「未绑定模型」的降级路径。 */
export class BudgetExceededError extends Error {
  constructor(readonly used: number, readonly budget: number) {
    // 该 message 会被引擎广播进公开事件流，只放运营需要的数字，不含上游细节
    super(`今日 LLM token 预算已用尽（${used}/${budget}），AI 发言暂时不可用`);
    this.name = "BudgetExceededError";
  }
}

const CACHE_TTL_MS = 60_000;

/** `LLM_DAILY_TOKEN_BUDGET`：0 / 未设置 / 非法值都表示关闭（决策 D3）。 */
export function dailyTokenBudget(): number {
  const raw = (process.env.LLM_DAILY_TOKEN_BUDGET ?? "").trim();
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 服务器本地时区的当天 00:00：预算按「本地一天」计，多时区部署各自自洽。 */
export function startOfLocalDay(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

let cached: { used: number; at: number; dayMs: number } | null = null;
let inflight: Promise<number> | null = null;

/** 供测试与改配置后手动失效使用。 */
export function resetBudgetCache(): void {
  cached = null;
  inflight = null;
}

async function queryUsedToday(dayMs: number): Promise<number> {
  const r = await db.usageLog.aggregate({
    where: { createdAt: { gte: new Date(dayMs) } },
    _sum: { totalTokens: true },
  });
  return r._sum.totalTokens ?? 0;
}

/** 60s 进程内缓存；并发调用共用同一次查询。 */
async function usedToday(): Promise<number> {
  const dayMs = startOfLocalDay().getTime();
  const now = Date.now();
  if (cached && cached.dayMs === dayMs && now - cached.at < CACHE_TTL_MS) return cached.used;
  if (!inflight) {
    inflight = (async () => {
      try {
        return await queryUsedToday(dayMs);
      } catch (err) {
        // 查不到就当 0 放行：resolveBinding 紧接着要读库，库不可用时这次调用本来也不会成功。
        // 结果仍写进缓存，避免库故障期间每次 LLM 调用都刷一条日志。
        log.warn("[llm] budget_query_failed，本次按未超预算放行", { error: err });
        return 0;
      }
    })().then((used) => {
      cached = { used, at: Date.now(), dayMs };
      return used;
    });
    inflight.finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** 不走缓存的当日合计，供用量看板显示（与熔断共用「本地当天」这一口径）。 */
export function usedTokensToday(): Promise<number> {
  return queryUsedToday(startOfLocalDay().getTime());
}

/** 三个 LLM 入口（chat / chatStream / embedTexts）的第一行调用；关闭时一次库都不查。 */
export async function assertWithinBudget(purpose = "llm"): Promise<void> {
  const budget = dailyTokenBudget();
  if (!budget) return;
  const used = await usedToday();
  if (used < budget) return;
  log.warn(`[llm] budget_exceeded purpose=${purpose} used=${used} budget=${budget}`, { purpose, used, budget });
  throw new BudgetExceededError(used, budget);
}
