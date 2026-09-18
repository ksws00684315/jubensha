import { describe, expect, it, vi } from "vitest";
import { evictBus, gameBus, publish, subscribe } from "./bus";

describe("gameBus 事件总线", () => {
  it("同一对局返回同一实例，不同对局互相隔离", () => {
    expect(gameBus("bus-iso")).toBe(gameBus("bus-iso"));
    expect(gameBus("bus-iso")).not.toBe(gameBus("bus-other"));
  });

  it("publish 只送达本局订阅者，unsubscribe 后停止投递", () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const offA = subscribe("bus-1", fnA);
    subscribe("bus-2", fnB);

    publish("bus-1", { kind: "event", event: { seq: "1" } as never });
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();

    offA();
    publish("bus-1", { kind: "event", event: { seq: "2" } as never });
    expect(fnA).toHaveBeenCalledTimes(1);
  });

  it("无订阅者时 publish 不抛错（终局后的迟到消息按丢弃处理）", () => {
    expect(() => publish("bus-nobody", { kind: "end" })).not.toThrow();
  });

  it("evictBus：仍有监听者不驱逐；全部退订后驱逐，下次访问按需重建", () => {
    const off = subscribe("bus-evict", () => undefined);
    const before = gameBus("bus-evict");
    evictBus("bus-evict");
    expect(gameBus("bus-evict")).toBe(before); // 监听者还在，实例未被替换

    off();
    evictBus("bus-evict");
    expect(gameBus("bus-evict")).not.toBe(before); // 已驱逐，按需重建
  });
});
