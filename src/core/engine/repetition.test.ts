import { describe, expect, it } from "vitest";
import { createRepetitionGuard, findRepetitionLoop } from "./repetition";
import { consumeStream } from "./turns";

const UNIT = "我昨晚确实去过码头，这句话千真万确，你们可以查证。"; // 25 字，高于最小片段阈值

describe("复读检测 findRepetitionLoop", () => {
  it("同一长片段第三次出现即熔断，截断点在最早一次出现处", () => {
    const text = `开场白。${UNIT}${UNIT}收尾。${UNIT}还要继续`;
    const loop = findRepetitionLoop(text);
    expect(loop).not.toBeNull();
    expect(text.slice(loop!.cutIndex, loop!.cutIndex + UNIT.length)).toBe(UNIT);
    expect(loop!.cutIndex).toBe(text.indexOf(UNIT));
  });

  it("合法修辞重复（短于最小片段）不误报", () => {
    expect(findRepetitionLoop("对对对对，你说的都对对对对。")).toBeNull();
    expect(findRepetitionLoop("好，好，好吧。".repeat(6))).toBeNull();
  });

  it("同一片段只出现两次不算循环", () => {
    expect(findRepetitionLoop(`前言${UNIT}中段${UNIT}后记`)).toBeNull();
  });

  it("只在尾部窗口内扫描：窗口外的旧重复不再触发", () => {
    const fresh = "新".repeat(4000);
    expect(findRepetitionLoop(`${UNIT}${UNIT}${UNIT}${fresh}`)).toBeNull();
  }, 20_000); // 4000 字尾部窗口扫描本身接近默认 5s，覆盖率插桩与 CI 单核下会超时
});

describe("增量守卫 createRepetitionGuard", () => {
  it("未命中时逐 delta 原样放行", () => {
    const guard = createRepetitionGuard();
    expect(guard.push("今天雨很大。")).toEqual({ approved: "今天雨很大。", loopDetected: false });
    expect(guard.push("我带了伞。").approved).toBe("我带了伞。");
  });

  it("流式逐 token 复读同样能检出，且命中后不再放行", () => {
    const guard = createRepetitionGuard();
    // 循环尾巴需多流出若干字符才能给出"片段完整"的断链证据，故后段足够长
    const stream = `先说两句。${UNIT}${UNIT}然后${UNIT}没完没了没完没了没完没了没完没了`;
    let detected: { cutIndex?: number } | null = null;
    for (const ch of stream) {
      const r = guard.push(ch);
      if (r.loopDetected) {
        detected = r;
        break;
      }
    }
    expect(detected).not.toBeNull();
    expect(detected!.cutIndex).toBe(stream.indexOf(UNIT));
    expect(guard.push("x")).toEqual({ approved: "", loopDetected: true });
  });
});

describe("consumeStream 集成", () => {
  const make = (chunks: string[]) => async function* () {
    for (const c of chunks) yield c;
  };
  const ctrl = new AbortController();

  it("病态重复流：命中后停发 delta、返回文本截到首次出现前", async () => {
    const deltas: string[] = [];
    const text = await consumeStream(
      make([`开场白。`, UNIT, UNIT, "尾。", UNIT, "还在重复"]),
      (d) => deltas.push(d),
      5_000,
      ctrl.signal
    );
    // delta 实时下发、命中前的无法撤回（观众已看到）；落库文本以截断为准
    expect(deltas.join("")).toBe(`开场白。${UNIT}${UNIT}尾。`);
    expect(text).toBe("开场白。");
  });

  it("正常流与现状逐字节一致", async () => {
    const deltas: string[] = [];
    const chunks = ["第一段发言内容。", "第二段接着说。", "第三段收尾。"];
    const text = await consumeStream(make(chunks), (d) => deltas.push(d), 5_000, ctrl.signal);
    expect(text).toBe(chunks.join(""));
    expect(deltas).toEqual(chunks);
  });

  it("opts.repetition=false 关闭熔断（旧行为）", async () => {
    const chunks = [UNIT, UNIT, "。", UNIT];
    const text = await consumeStream(make(chunks), () => {}, 5_000, ctrl.signal, { repetition: false });
    expect(text).toBe(chunks.join(""));
  });

  it("超时先于复读发生时以超时为准，已放行文本保留", async () => {
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveGate = r));
    async function* slow() {
      yield `开场。${UNIT}`;
      await gate;
      yield UNIT;
      yield UNIT;
    }
    const text = await consumeStream(() => slow(), () => {}, 50, ctrl.signal);
    resolveGate();
    expect(text).toBe(`开场。${UNIT}`);
  });
});
