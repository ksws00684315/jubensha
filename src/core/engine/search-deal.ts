import { db } from "@/lib/db";
import { clueText, resolveLocation } from "@/core/script/compat";
import { agent } from "@/core/agents";
import { activeSeats, clueReachable } from "./state";
import { searchLocationOptions } from "./search-locations";
import { afterSearchPhase } from "./phases";
import { AI_DECISION_TIMEOUT_MS, HUMAN_TURN_TIMEOUT_MS, withTimeout } from "./util";
import { jevLocationFallback, shadowLocation, shadowPublish } from "@/core/jev/live";
import type { GameEngine } from "./engine";

/**
 * ★ 搜证域（批次 I1 自 engine.ts 拆出）★：
 * 地点可见性、线索发放/兜底补发、公开/私藏决策（人类限时 + AI 后台）。
 */

/** 本轮无可搜地点时占位 searchChoices 的哨兵值：分发放线索时跳过，选点报错时给出区分文案。 */
export const NO_SEARCH_CHOICE = "__no_search__";

/** 某座位角色的 id（线索发放权限/禁搜自己房间判定用） */
export function seatCharacterId(e: GameEngine, seatIndex: number | null | undefined): string | null {
  if (seatIndex == null) return null;
  return e.state.seats[seatIndex]?.characterId || null;
}

/** 某座位角色卡上的技能卡 */
export function skillOf(e: GameEngine, seatIndex: number, skillId: string) {
  const charId = seatCharacterId(e, seatIndex);
  return e.script.characters.find((c) => c.id === charId)?.privateCard.skills.find((s) => s.id === skillId);
}

/** 公开线索 id 集合（搜证权限/发放计划用） */
export function publicClueIds(e: GameEngine): Set<string> {
  return new Set(Object.entries(e.state.clueStates).filter(([, st]) => st.isPublic).map(([id]) => id));
}

/** 某座位视角下可用的搜证地点（禁搜自己的房间/无可达线索的地点不列） */
export function availableLocations(e: GameEngine, seatIndex?: number): string[] {
  return searchLocationOptions({
    locations: e.script.locations,
    clues: e.script.clues,
    clueStates: e.state.clueStates,
    seatCharacterId: seatCharacterId(e, seatIndex),
    round: e.state.round,
  }).filter((option) => option.status === "available").map((option) => option.name);
}

/** 兜底地点：无视发放计划/禁搜线索，但绝不给本人房间——只在正常列表为空时使用，保证流程不卡死。 */
export function fallbackLocations(e: GameEngine, seatIndex?: number): string[] {
  const seatChar = seatCharacterId(e, seatIndex);
  return e.script.locations
    .filter((loc) => !(seatChar && loc.ownerCharacterId === seatChar))
    .filter((loc) => e.script.clues.some((c) => c.locationId === loc.id && e.state.clueStates[c.id] === undefined))
    .map((loc) => loc.name);
}

export function cluesAt(e: GameEngine, locationKey: string, seatIndex?: number) {
  const loc = resolveLocation(e.script, locationKey);
  if (!loc) return [];
  const seatChar = seatCharacterId(e, seatIndex);
  if (seatChar && loc.ownerCharacterId === seatChar) return [];
  return e.script.clues.filter(
    (c) => c.locationId === loc.id && e.state.clueStates[c.id] === undefined && clueReachable(c, { seatCharacterId: seatChar, round: e.state.round, publicClueIds: publicClueIds(e) })
  );
}

/** AI 选点放到互斥队列外的定时器里，避免卡住真人点击地点的 HTTP。 */
export function queueAiSearchChoice(e: GameEngine, seat: number): void {
  if (e.searchAsked.has(seat)) return;
  e.searchAsked.add(seat);
  e.scheduleBackground(`search-ai:${e.state.round}:${seat}`, async () => {
    if (e.state.phase !== "SEARCH") return;
    if (e.state.searchChoices[String(seat)]) return;
    const locations = availableLocations(e, seat);
    let loc: string;
    let modelChoice: string | null = null;
    try {
      loc = await withTimeout(agent.playerChooseLocation(e.ctx(), seat, locations), AI_DECISION_TIMEOUT_MS);
      modelChoice = loc;
    } catch {
      loc = (await jevLocationFallback(e.ctx(), seat, locations)) ?? locations[Math.floor(Math.random() * locations.length)] ?? "";
    }
    const resolved = resolveLocation(e.script, loc);
    if (!resolved) loc = locations[Math.floor(Math.random() * locations.length)] ?? "";
    else if (locations.length > 0 && !locations.includes(resolved.name)) loc = locations[Math.floor(Math.random() * locations.length)] ?? "";
    if (modelChoice !== null) void shadowLocation(e.ctx(), seat, locations, modelChoice);
    if (!loc) return;
    await e.exclusive(async () => {
      if (e.state.phase !== "SEARCH" || e.state.searchChoices[String(seat)]) return;
      e.state.searchChoices[String(seat)] = loc;
      await e.systemSay(`你选择了「${loc}」搜证。`, seat);
      await e.persist();
      await e.tickInner();
    });
  }, 50 + seat * 40);
}

export async function dispatchClues(e: GameEngine): Promise<void> {
  for (const seat of activeSeats(e.state)) {
    const loc = e.state.searchChoices[String(seat)];
    if (!loc) continue;
    if (loc === NO_SEARCH_CHOICE) continue;
    const seatChar = seatCharacterId(e, seat);
    const chosen = resolveLocation(e.script, loc);
    if (seatChar && chosen?.ownerCharacterId === seatChar) {
      await e.systemSay(`（你不能搜自己的房间，本轮搜证落空。）`, seat);
      continue;
    }
    const candidates = cluesAt(e, loc, seat);
    if (!candidates.length) {
      await e.systemSay(`你翻遍了「${loc}」，一无所获。`, seat);
      continue;
    }
    const clue = candidates[Math.floor(Math.random() * candidates.length)];
    const autoPublic = clue.policy === "auto_public";
    e.state.clueStates[clue.id] = { discoveredBy: seat, isPublic: autoPublic };
    e.state.heldClues[seat] = [...(e.state.heldClues[seat] ?? []), clue.id];
    await e.recordEvent({
      type: "clue",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: seat,
      toSeat: null,
      visibility: `seat:${seat}`,
      content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), location: loc, private: !autoPublic },
    });
    const guarantee = e.script.hostGuide?.guaranteedPublicClues.find((item) => item.clueId === clue.id);
    const guaranteeRound = guarantee ? effectiveGuaranteeRound(e, clue.id, guarantee.deadlineRound) : null;
    const dueThisRound = guaranteeRound !== null && guaranteeRound <= e.state.round;
    const privateHint = autoPublic
      ? "该线索为公开线索，已向全场公示。"
      : dueThisRound
        ? "可公开或暂时私藏，本轮结束由主持公开。"
        : guaranteeRound !== null
          ? `你可以选择当场公开或私藏；该线索最迟第 ${guaranteeRound} 轮结束将由主持公开。`
          : "你可以选择当场公开或私藏。";
    await e.systemSay(`你在「${loc}」搜到了线索卡【${clue.name}】。${privateHint}`, seat);
    if (autoPublic) {
      await e.recordEvent({
        type: "clue",
        phase: e.state.phase,
        round: e.state.round,
        fromSeat: seat,
        toSeat: null,
        visibility: "public",
        content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), publicBy: seat },
      });
    } else if (clue.policy !== "keep_private") {
      e.state.pendingPublish[String(seat)] = [...(e.state.pendingPublish[String(seat)] ?? []), clue.id];
    }
  }
  // 更新 seatStates
  for (const seat of activeSeats(e.state)) {
    await syncSeatClueIds(e, seat);
  }
}

const GUARANTEE_BUDGET_PER_ROUND = 2;

function effectiveGuaranteeRound(e: GameEngine, clueId: string, deadlineRound: number): number {
  return Math.max(deadlineRound, e.state.guaranteeDeferUntil?.[clueId] ?? deadlineRound);
}

/** 本轮是否还欠着、且生效截止不晚于本轮的保证材料。 */
function guaranteeStillDue(e: GameEngine): boolean {
  return (e.script.hostGuide?.guaranteedPublicClues ?? []).some((item) => {
    if (effectiveGuaranteeRound(e, item.clueId, item.deadlineRound) > e.state.round) return false;
    if (e.state.hostHandouts?.[item.clueId]) return false;
    const clue = e.script.clues.find((candidate) => candidate.id === item.clueId);
    return Boolean(clue && clue.policy !== "keep_private" && !e.state.clueStates[item.clueId]?.isPublic);
  });
}

/** 唯一搜证结算入口：玩家决策完成后才补发。每轮最多两张，发不完的推迟到下一轮。 */
export async function finalizeSearchRound(e: GameEngine): Promise<void> {
  if (e.state.phase !== "SEARCH" || e.state.searchDealtRound !== e.state.round) return;
  if (Object.values(e.state.pendingPublish).some((ids) => ids.length)) return;
  await dispatchGuaranteedPublicClues(e);
  await e.persist();
  if (guaranteeStillDue(e)) return;
  await afterSearchPhase(e);
}

async function publishGuarantee(e: GameEngine, clueId: string, reason: "deadline_guarantee" | "vote_flush"): Promise<void> {
  const clue = e.script.clues.find((candidate) => candidate.id === clueId);
  if (!clue || clue.policy === "keep_private" || e.state.hostHandouts?.[clueId]) return;
  const current = e.state.clueStates[clueId];
  if (current?.isPublic) {
    for (const seat of Object.keys(e.state.pendingPublish)) {
      e.state.pendingPublish[seat] = (e.state.pendingPublish[seat] ?? []).filter((id) => id !== clueId);
    }
    e.state.hostHandouts![clueId] = { round: e.state.round, reason: "already_public" };
    return;
  }
  e.state.clueStates[clueId] = { discoveredBy: current?.discoveredBy ?? null, isPublic: true };
  for (const seat of Object.keys(e.state.pendingPublish)) {
    e.state.pendingPublish[seat] = (e.state.pendingPublish[seat] ?? []).filter((id) => id !== clueId);
  }
  e.state.hostHandouts![clueId] = { round: e.state.round, reason };
  await e.recordEvent({
    type: "clue",
    phase: e.state.phase,
    round: e.state.round,
    fromSeat: null,
    toSeat: null,
    visibility: "public",
    content: { clueId: clue.id, clueName: clue.name, clueContent: clueText(clue), hostRelease: true, batchId: `search:${e.state.round}`, deadlineRound: e.state.round },
  });
  await e.systemSay(`主持人公开补发关键材料：线索卡【${clue.name}】。`);
  // 原发现人私藏的牌被强制公开，必须让他第一时间知道，而不是等公开线索刷出来自己发现
  if (current?.discoveredBy != null) {
    await e.systemSay(`你私藏的【${clue.name}】已到保底公开时限，主持人已当众公开。`, current.discoveredBy);
  }
}

/** 到达生效截止轮仍未公开时补发。一轮最多两张，其余推迟到下一搜证轮。 */
export async function dispatchGuaranteedPublicClues(e: GameEngine): Promise<void> {
  e.state.hostHandouts ??= {};
  e.state.guaranteeDeferUntil ??= {};
  let emitted = 0;
  const deferred: string[] = [];
  const guarantees = e.script.hostGuide?.guaranteedPublicClues ?? [];
  for (const item of guarantees) {
    if (effectiveGuaranteeRound(e, item.clueId, item.deadlineRound) > e.state.round || e.state.hostHandouts?.[item.clueId]) continue;
    const clue = e.script.clues.find((candidate) => candidate.id === item.clueId);
    if (!clue || clue.policy === "keep_private") continue;
    if (e.state.clueStates[item.clueId]?.isPublic) {
      await publishGuarantee(e, item.clueId, "deadline_guarantee");
      continue;
    }
    if (emitted >= GUARANTEE_BUDGET_PER_ROUND) {
      deferred.push(item.clueId);
      continue;
    }
    emitted++;
    await publishGuarantee(e, item.clueId, "deadline_guarantee");
  }
  for (const clueId of deferred) e.state.guaranteeDeferUntil[clueId] = e.state.round + 1;
}

/** 进入投票前把仍未公开的保证材料一次补完，避免被轮预算永久拦住。 */
export async function flushRemainingGuarantees(e: GameEngine): Promise<void> {
  e.state.hostHandouts ??= {};
  for (const item of e.script.hostGuide?.guaranteedPublicClues ?? []) {
    const clue = e.script.clues.find((candidate) => candidate.id === item.clueId);
    if (!clue || clue.policy === "keep_private" || e.state.hostHandouts?.[item.clueId]) continue;
    await publishGuarantee(e, item.clueId, "vote_flush");
  }
}

/** 把某座位的持有线索写回 seatState（概要接口 myClues 的数据源） */
export async function syncSeatClueIds(e: GameEngine, seat: number): Promise<void> {
  await db.seatState
    .upsert({
      where: { gameId_seatIndex: { gameId: e.gameId, seatIndex: seat } },
      create: { gameId: e.gameId, seatIndex: seat, data: { clueIds: e.state.heldClues[seat] ?? [] } },
      update: { data: { clueIds: e.state.heldClues[seat] ?? [] } },
    })
    .catch(() => null);
}

export async function collectPublishDecisions(e: GameEngine): Promise<void> {
  for (const seatStr of Object.keys(e.state.pendingPublish)) {
    const seat = Number(seatStr);
    if (!(e.state.pendingPublish[seatStr] ?? []).length) continue;
    if (e.state.seats[seat]?.kind !== "ai") {
      if (!e.publishAsked.has(seat)) {
        e.publishAsked.add(seat);
        await e.systemSay(
          e.unlimitedHumanTurns
            ? `请决定：是否公开你刚获得的线索？（左侧"我的线索"中操作）`
            : `请决定：是否公开你刚获得的线索？（左侧"我的线索"中操作，超时将自动私藏）`,
          seat,
        );
        if (!e.unlimitedHumanTurns) {
          e.schedule(`pub:${seat}`, async () => {
            if (e.state.phase !== "SEARCH") return;
            const pending = e.state.pendingPublish[String(seat)] ?? [];
            if (!pending.length) return;
            await e.systemSay(
              `（你已超过 3 分钟未操作，线索已全部自动私藏。）`,
              seat,
              { timeoutSkip: true }
            );
            for (const clueId of pending) await applyPublish(e, seat, clueId, false);
            e.state.pendingPublish[String(seat)] = [];
            await e.persist();
            if (Object.values(e.state.pendingPublish).every((arr) => !arr.length)) {
              await finalizeSearchRound(e);
            }
          }, HUMAN_TURN_TIMEOUT_MS);
        }
      }
      continue;
    }
    queueAiPublish(e, seat);
  }
}

export function queueAiPublish(e: GameEngine, seat: number): void {
  if (e.publishAsked.has(seat)) return;
  e.publishAsked.add(seat);
  e.scheduleBackground(`pub-ai:${e.state.round}:${seat}`, async () => {
    if (e.state.phase !== "SEARCH") return;
    const clueIds = e.state.pendingPublish[String(seat)] ?? [];
    const decisions: Array<[string, boolean]> = [];
    for (const clueId of clueIds) {
      let publish = false;
      let decided = false;
      try {
        publish = await withTimeout(agent.playerChoosePublish(e.ctx(), seat, clueId), AI_DECISION_TIMEOUT_MS);
        decided = true;
      } catch {
        // 这条兜底不是随机而是"私藏"，没有可让 Jev 接管的空间，只留影子对照
        publish = false;
      }
      if (decided) void shadowPublish(e.ctx(), seat, clueId, publish);
      decisions.push([clueId, publish]);
    }
    await e.exclusive(async () => {
      if (e.state.phase !== "SEARCH") return;
      for (const [clueId, shouldPublish] of decisions) {
        const pending = e.state.pendingPublish[String(seat)] ?? [];
        if (pending.includes(clueId)) await applyPublish(e, seat, clueId, shouldPublish);
      }
      e.state.pendingPublish[String(seat)] = [];
      await e.persist();
      await e.tickInner();
    });
  }, 50 + seat * 40);
}

export async function applyPublish(e: GameEngine, seat: number, clueId: string, publish: boolean): Promise<void> {
  const clue = e.script.clues.find((c) => c.id === clueId);
  if (!clue || e.state.clueStates[clueId]?.isPublic) return;
  if (publish && clue.policy === "keep_private") return;
  if (publish) {
    e.state.clueStates[clueId].isPublic = true;
    await e.recordEvent({
      type: "clue",
      phase: e.state.phase,
      round: e.state.round,
      fromSeat: seat,
      toSeat: null,
      visibility: "public",
      content: { clueId, clueName: clue.name, clueContent: clueText(clue), publicBy: seat },
    });
  } else {
    await e.systemSay(`你决定私藏线索【${clue.name}】。`, seat);
  }
}
