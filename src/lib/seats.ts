/** 为未指定角色的座位按剧本角色表顺序补齐，保证不重复。 */
export function assignCharacterIds(
  seats: Array<{ kind: string; characterId?: string | null }>,
  characterIds: string[]
): Array<string | null> {
  const used = new Set(seats.map((s) => s.characterId).filter((id): id is string => Boolean(id)));
  const remaining = characterIds.filter((id) => !used.has(id));
  return seats.map((s) => {
    if (s.kind === "empty") return null;
    if (s.characterId) return s.characterId;
    return remaining.shift() ?? null;
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
