import { evictBus } from "./bus";
import { releaseLease } from "./lease";
import type { GameEngine } from "./engine";
import { log } from "@/lib/log";

/**
 * 常驻引擎注册表（批次 I1 自 engine.ts 下沉）：
 * globalThis 上的实例表与去重加载表归这里管，供引擎本体与阶段模块（终局驱逐）共用，
 * 避免模块间运行时循环。
 */

// Keep the registry and timers across Next dev reloads; values are initialized below.
const g = globalThis as typeof globalThis & {
  __jbsEngines?: Map<string, GameEngine>;
  __jbsEngineLoads?: Map<string, Promise<GameEngine>>;
  __jbsStuckWatchTimer?: NodeJS.Timeout;
  __jbsStuckWarnings?: Map<string, number>;
};
export const engines = (g.__jbsEngines ??= new Map<string, GameEngine>());
export const engineLoads = (g.__jbsEngineLoads ??= new Map<string, Promise<GameEngine>>());

const STUCK_CHECK_INTERVAL_MS = 60_000;
const STUCK_THRESHOLD_MS = 5 * 60_000;
const STUCK_LOG_THROTTLE_MS = 15 * 60_000;
const lastStuckWarnings = (g.__jbsStuckWarnings ??= new Map<string, number>());

function checkStuckEngines(now: number): void {
  for (const [gameId, engine] of engines) {
    if (engine.state.phase === "ENDED" || engine.turnInFlight) continue;
    if (Object.values(engine.state.humanDeadlines ?? {}).some((deadline) => deadline > now)) continue;
    const lastEventAt = Date.parse(engine.events.at(-1)?.createdAt ?? "");
    if (!Number.isFinite(lastEventAt)) continue;
    const idleMs = now - lastEventAt;
    if (idleMs <= STUCK_THRESHOLD_MS) continue;
    const lastWarnedAt = lastStuckWarnings.get(gameId);
    if (lastWarnedAt !== undefined && now - lastWarnedAt < STUCK_LOG_THROTTLE_MS) continue;

    log.warn("engine.stuck", {
      gameId,
      phase: engine.state.phase,
      round: engine.state.round,
      idleSec: Math.floor(idleMs / 1_000),
    });
    lastStuckWarnings.set(gameId, now);
  }

  for (const gameId of lastStuckWarnings.keys()) {
    if (!engines.has(gameId)) lastStuckWarnings.delete(gameId);
  }
}

if (!g.__jbsStuckWatchTimer) {
  g.__jbsStuckWatchTimer = setInterval(() => checkStuckEngines(Date.now()), STUCK_CHECK_INTERVAL_MS);
  g.__jbsStuckWatchTimer.unref?.();
}

/** 常驻对局引擎软上限：终局有延迟驱逐兜底，超过软上限说明有泄漏，打告警。 */
const ENGINES_SOFT_CAP = 200;
/** 终局落库后延迟驱逐时长：留窗口给复盘页/SSE 尾随读取，之后按需重建。 */
const ENDED_EVICTION_DELAY_MS = 10 * 60_000;

export function rememberEngine(gameId: string, engine: GameEngine): void {
  engines.set(gameId, engine);
  if (engines.size > ENGINES_SOFT_CAP) {
    log.warn("[engine] 常驻对局引擎数量超过软上限；请检查终局驱逐是否生效", { engineCount: engines.size, softCap: ENGINES_SOFT_CAP });
  }
}

/** 终局延迟驱逐：复盘页/SSE 尾随读完后释放内存；后续访问走 load 按需重建。 */
export function scheduleEndedEviction(engine: GameEngine): void {
  const timer = setTimeout(() => {
    if (engines.get(engine.gameId) === engine && engine.state.phase === "ENDED") {
      engines.delete(engine.gameId);
      evictBus(engine.gameId);
      // 交牌一并做：已经打完的对局不该让别的实例等满 30s TTL 才能重建（比如复盘重放）。
      void releaseLease(engine.gameId, engine.ownerId).catch(() => null);
    }
  }, ENDED_EVICTION_DELAY_MS);
  timer.unref?.();
}
