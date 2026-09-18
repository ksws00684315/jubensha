import { evictBus } from "./bus";
import type { GameEngine } from "./engine";

/**
 * 常驻引擎注册表（批次 I1 自 engine.ts 下沉）：
 * globalThis 上的实例表与去重加载表归这里管，供引擎本体与阶段模块（终局驱逐）共用，
 * 避免模块间运行时循环。
 */

const g = globalThis as unknown as {
  __jbsEngines?: Map<string, GameEngine>;
  __jbsEngineLoads?: Map<string, Promise<GameEngine>>;
};
export const engines = (g.__jbsEngines ??= new Map<string, GameEngine>());
export const engineLoads = (g.__jbsEngineLoads ??= new Map<string, Promise<GameEngine>>());

/** 常驻对局引擎软上限：终局有延迟驱逐兜底，超过软上限说明有泄漏，打告警。 */
const ENGINES_SOFT_CAP = 200;
/** 终局落库后延迟驱逐时长：留窗口给复盘页/SSE 尾随读取，之后按需重建。 */
const ENDED_EVICTION_DELAY_MS = 10 * 60_000;

export function rememberEngine(gameId: string, engine: GameEngine): void {
  engines.set(gameId, engine);
  if (engines.size > ENGINES_SOFT_CAP) {
    console.warn(`[engine] 常驻对局引擎 ${engines.size} 个，超过软上限 ${ENGINES_SOFT_CAP}；请检查终局驱逐是否生效`);
  }
}

/** 终局延迟驱逐：复盘页/SSE 尾随读完后释放内存；后续访问走 load 按需重建。 */
export function scheduleEndedEviction(engine: GameEngine): void {
  const timer = setTimeout(() => {
    if (engines.get(engine.gameId) === engine && engine.state.phase === "ENDED") {
      engines.delete(engine.gameId);
      evictBus(engine.gameId);
    }
  }, ENDED_EVICTION_DELAY_MS);
  timer.unref?.();
}
