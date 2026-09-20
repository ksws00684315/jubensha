/**
 * ★ 流式防复读熔断 ★
 * 长生成退化（同一完整循环片段在尾部窗口内互不重叠出现 maxRepeats 次）时截断：
 * 保留循环片段最早一次出现的起点之前的文本，病态循环段整体丢弃。
 * 片段取"左连续完整形态"（见 findRepetitionLoop 内注释），判定各次出现互不重叠：
 * 周期性合法文本（"好，好，好吧。"）的跨界 n-gram 级联间距等于短周期，必被排除；
 * 带插话的真循环（间距不等但均 ≥ 片段长度）仍能检出。
 * minUnitChars 取 18 让"对，对，你说得对"式短修辞远离判定区。
 * 纯函数 + 尾部窗口扫描，由 consumeStream 逐 delta 增量调用（内部节流）。
 */

export interface RepetitionOptions {
  /** 复读片段的最小长度；短于此不视为循环 */
  minUnitChars?: number;
  /** 同一片段在窗口内要求的最少互不重叠出现次数 */
  maxRepeats?: number;
  /** 只在此尾部窗口内扫描（字符） */
  window?: number;
}

const DEFAULTS = { minUnitChars: 18, maxRepeats: 3, window: 2000 };
// 循环片段长度上限：防止扫描量随窗口线性放大
const MAX_UNIT_CHARS = 96;

/** s 中从 i、j 起的最长公共前缀长度 */
function lcp(s: string, i: number, j: number): number {
  let k = 0;
  while (i + k < s.length && j + k < s.length && s[i + k] === s[j + k]) k++;
  return k;
}

/**
 * 在 text 的尾部窗口内找病态循环：返回截断点 cutIndex
 * （循环片段最早一次出现的起点）。无循环返回 null。
 *
 * 做法：n 从最长档向下扫字符 n-gram，候选 = 互不重叠（相邻间距 ≥n）的
 * maxRepeats 连；片段取左连续完整形态 e = min(首段间距, 与首现的 LCP)，
 * 并要求中间某次出现在 e 之后给出与首现不同的上下文（片段确实完整走完）——
 * 贴到文本尾、尚未流出的那次不算（流式途中末次出现天然被截短，
 * 病态循环的尾巴照样要熔断）。
 * 优先取 e 最大的候选：被更左起点截走的是"差一字的跨界前缀"，
 * 完整片段才是真循环单元；n 下探到已选 e 即可定案（更短的 n 只会给出更小的 e）。
 */
export function findRepetitionLoop(text: string, opts: RepetitionOptions = {}): { cutIndex: number } | null {
  const { minUnitChars, maxRepeats, window } = { ...DEFAULTS, ...opts };
  const start = Math.max(0, text.length - window);
  const span = text.length - start;
  if (span < minUnitChars * maxRepeats) return null;
  let best: { cut: number; e: number } | null = null;
  const top = Math.min(MAX_UNIT_CHARS, Math.floor(span / maxRepeats));
  for (let n = top; n >= minUnitChars; n--) {
    if (best && n <= best.e) return { cutIndex: best.cut };
    const counts = new Map<string, number[]>();
    for (let i = start; i + n <= text.length; i++) {
      const gram = text.slice(i, i + n);
      const hits = counts.get(gram) ?? [];
      hits.push(i);
      counts.set(gram, hits);
      if (hits.length < maxRepeats) continue;
      outer: for (let a = 0; a + maxRepeats <= hits.length; a++) {
        const occ = hits.slice(a, a + maxRepeats);
        // 互不重叠：相邻间距均 ≥ 片段长度
        for (let k = 1; k < maxRepeats; k++) {
          if (occ[k] - occ[k - 1] < n) continue outer;
        }
        let e = occ[1] - occ[0];
        for (let k = 1; k < maxRepeats; k++) e = Math.min(e, lcp(text, occ[0], occ[k]));
        if (e < minUnitChars) continue;
        // 左连续校验：中间某次出现的 e 之后必须给出"不同上下文"（后随字符 ≠
        // 首现的后随字符），证明片段已完整；紧跟下一次出现（循环还在走）或
        // 尚未流出（贴到文本尾）都不算证据。只贴在末次上的不算——
        // 流式途中末次出现天然被截短，病态循环的尾巴照样要熔断。
        const lastOcc = occ[maxRepeats - 1];
        let complete = false;
        let linked = false;
        for (let k = 1; k < maxRepeats; k++) {
          const cont = text[occ[k] + e];
          if (cont === undefined) continue;
          if (cont === text[occ[0] + e]) { linked = true; break; }
          if (occ[k] + e < lastOcc) complete = true;
        }
        if (linked || !complete) continue;
        // 起点落在已选片段内部=同一循环的"差一字跨界前缀"，弃；否则按更完整（e 更大）者胜出
        if (best && occ[0] > best.cut && occ[0] < best.cut + best.e) continue;
        if (!best || e > best.e) best = { cut: occ[0], e };
      }
    }
  }
  return best ? { cutIndex: best.cut } : null;
}

export interface RepetitionGuard {
  /** 喂入增量：未熔断时放行原文；命中时 loopDetected 置位、approved 为空，
   * cutIndex 为全文截断点（由调用方决定最终落库文本）。 */
  push(delta: string): { approved: string; loopDetected: boolean; cutIndex?: number };
  /** 流正常结束时补扫节流窗口内的尾段：循环尾巴恰好落在两次扫描之间时不漏判。 */
  finish(): { loopDetected: boolean; cutIndex?: number };
}

export function createRepetitionGuard(opts: RepetitionOptions = {}): RepetitionGuard {
  let full = "";
  let broken = false;
  // 上次扫描时"已被判定覆盖"的前缀长度：一个片段窗口的尾巴尚未露出下一次
  // 出现的完整形态，推进不足 minUnitChars 时结论不可能改变。
  let lastScanned = 0;
  const minNewScan = (opts.minUnitChars ?? DEFAULTS.minUnitChars) + 1;
  const scan = (): { loopDetected: boolean; cutIndex?: number } => {
    lastScanned = full.length;
    const loop = findRepetitionLoop(full, opts);
    if (loop) {
      broken = true;
      return { loopDetected: true, cutIndex: loop.cutIndex };
    }
    return { loopDetected: false };
  };
  return {
    push(delta: string) {
      if (broken) return { approved: "", loopDetected: true };
      full += delta;
      if (full.length - lastScanned >= minNewScan) {
        const r = scan();
        if (r.loopDetected) return { approved: "", loopDetected: true, cutIndex: r.cutIndex };
      }
      return { approved: delta, loopDetected: false };
    },
    finish() {
      if (broken || full.length === lastScanned) return { loopDetected: broken };
      return scan();
    },
  };
}
