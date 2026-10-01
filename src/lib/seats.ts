/** 默认洗牌：Fisher–Yates，原地等概率打乱。 */
function defaultShuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * 为未指定角色的座位补齐角色，保证不重复。
 * D-1 拍板（2026-10-01）：剩余角色池默认洗牌后填入，房主显式指定的座位保留原角色——
 * 顺序分配曾让"选座即选角"可预知（实测两间房 seat 0 都抽到同一角色）。
 * shuffle 参数仅供测试注入确定性打乱，生产调用方不传。
 */
export function assignCharacterIds(
  seats: Array<{ kind: string; characterId?: string | null }>,
  characterIds: string[],
  shuffle: (items: string[]) => string[] = defaultShuffle,
): Array<string | null> {
  const used = new Set(seats.map((s) => s.characterId).filter((id): id is string => Boolean(id)));
  const remaining = shuffle(characterIds.filter((id) => !used.has(id)));
  const queue = [...remaining];
  return seats.map((s) => {
    if (s.kind === "empty") return null;
    if (s.characterId) return s.characterId;
    return queue.shift() ?? null;
  });
}

export function hasDuplicateCharacterIds(ids: Array<string | null | undefined>): boolean {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}
