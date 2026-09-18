import type { BusMessage } from "./types";
import { EventEmitter } from "node:events";

/**
 * 每局对局一个事件总线：AI 流式 delta、新事件落库后推给所有 SSE 订阅者。
 * 挂在 globalThis 上，避免 dev 热重载产生多实例。
 */
const g = globalThis as unknown as { __jbsBus?: Map<string, EventEmitter> };
const buses = (g.__jbsBus ??= new Map<string, EventEmitter>());

export function gameBus(gameId: string): EventEmitter {
  let bus = buses.get(gameId);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(50);
    buses.set(gameId, bus);
  }
  return bus;
}

export function publish(gameId: string, msg: BusMessage): void {
  gameBus(gameId).emit("message", msg);
}

/** 终局延迟驱逐：对局已结算且无重连价值时释放总线（下一次访问会按需重建）。 */
export function evictBus(gameId: string): void {
  const bus = buses.get(gameId);
  if (bus && bus.listenerCount("message") === 0) buses.delete(gameId);
}

export function subscribe(gameId: string, fn: (msg: BusMessage) => void): () => void {
  const bus = gameBus(gameId);
  bus.on("message", fn);
  return () => bus.off("message", fn);
}
