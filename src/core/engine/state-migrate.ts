import { initialState } from "./state";
import { parseGameState } from "./state-schema";
import type { GameState } from "./types";

/** 快照的当前版本号在 types.ts 定义（避开 state ↔ state-migrate 的模块环），这里透传一次便于使用 */
export { CURRENT_STATE_VERSION } from "./types";

/**
 * `games.state` 快照的版本化迁移（S4.3）。
 *
 * ## 新增状态字段的规则
 * 1. 在 `types.ts` 的 `GameState` 上加字段；
 * 2. 若字段是**可选**的（旧快照读不到值不影响正确性），只需把它加进 `ensureCurrentFields()`
 *    补一个默认值，**不必**升版本号——每次加载都会走这段归一化；
 * 3. 若字段**改变语义或结构**（旧快照必须被改写），则 `CURRENT_STATE_VERSION` +1，
 *    并在 `MIGRATIONS` 末尾追加一条 `{ to: 新版本号, run }`，`run` 里只处理
 *    「上一版本 → 本版本」的改写，并把 `draft.stateVersion` 写成自己的目标版本；
 * 4. 同步在 `state-schema.ts` 里声明该字段，并在 `__fixtures__/state/` 补一份旧版本快照。
 *
 * 迁移是幂等的：`migrateState(migrateState(x))` 与 `migrateState(x)` 结果相同。
 */

/** 加载期上下文：迁移不得读全局时钟，`now` 由调用方注入 */
export interface MigrateContext {
  /** 本次加载的时刻（epoch ms），用于清理重启后已过期的真人限时截止 */
  now: number;
  /** 对局 id，用于给旧格式提问补 questionId */
  gameId: string;
}

/** 尚未通过校验的历史快照：字段可能缺失，也可能有 schema 之外的残留字段 */
type Draft = Partial<GameState> & Record<string, unknown>;

interface Migration {
  to: number;
  run: (draft: Draft, ctx: MigrateContext) => void;
}

const MIGRATIONS: Migration[] = [
  {
    // v0：没有 stateVersion 字段的快照，即 S4.3 之前所有线上数据。
    // v0 与 v1 的结构差异只有版本号本身；缺字段由 ensureCurrentFields() 统一补，
    // 因此这条迁移不额外改写数据，只登记版本。
    to: 1,
    run: (draft) => {
      draft.stateVersion = 1;
    },
  },
];

/**
 * 补齐当前形态的全部字段默认值。逻辑与原 `GameEngine.load()` 中的 `??=` 段一致。
 * 每次加载都执行（幂等），所以新增可选字段不必升版本号。
 */
function ensureCurrentFields(draft: Draft): void {
  draft.pendingPublish ??= {};
  draft.heldClues ??= {};
  draft.searchChoices ??= {};
  draft.votes ??= {};
  draft.privateChat ??= {};
  draft.readySeats ??= [];
  draft.readingPromptedSeats ??= [];
  draft.spokenSeats ??= [];
  draft.searchDealtRound ??= 0;
  draft.questionsLeft ??= {};
  draft.pendingAnswer ??= null;
  draft.humanDeadlines ??= {};
  draft.actionPoints ??= {};
  draft.usedSkills ??= [];
  draft.quizAnswers ??= {};
  draft.quizResult ??= null;
  draft.unlockedSecrets ??= {};
  draft.hostHandouts ??= {};
  draft.guaranteeDeferUntil ??= {};
  draft.hostHints ??= {};
  draft.actionPlans ??= {};
  draft.pendingInteraction ??= null;
  draft.interactionChoices ??= {};
  // 旧快照可能没有这个字段：不补默认会让 `undefined++` 变成 NaN，
  // 而 `NaN >= 上限` 恒为假 → 该轮插话上限彻底失效。字段虽标 deprecated，但仍在读写。
  draft.interjections ??= 0;
}

/**
 * 与版本无关的加载期清理，原 `load()` 每次都会做，因此每个版本的快照都要过一遍。
 */
function normalizeOnLoad(draft: Draft, ctx: MigrateContext): void {
  const answer = draft.pendingAnswer;
  if (answer) answer.questionId ??= `legacy:${ctx.gameId}:${draft.round}:${answer.fromSeat}:${answer.toSeat}`;
  // 兼容曾被主持保证公开、却仍残留在待决策队列中的快照。
  // 玩家端不会为已公开线索显示“公开/私藏”按钮，若不清理会在搜证阶段死锁。
  const pendingPublish = draft.pendingPublish ?? {};
  for (const seat of Object.keys(pendingPublish)) {
    pendingPublish[seat] = (pendingPublish[seat] ?? []).filter((id) => !draft.clueStates?.[id]?.isPublic);
  }
  // 服务重启后内存定时器已丢失，过期截止时间一并清掉，避免前端挂着永不跳转的倒计时
  const humanDeadlines = draft.humanDeadlines ?? {};
  for (const k of Object.keys(humanDeadlines)) {
    if (humanDeadlines[k] <= ctx.now) delete humanDeadlines[k];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读入一份 `games.state`（可能是任意历史版本、`null`、甚至非对象），
 * 迁移到当前版本并通过 schema 校验。校验失败会抛 `ZodError`。
 */
export function migrateState(raw: unknown, ctx: MigrateContext): GameState {
  // 与原 load() 一致：`games.state` 为空时按空座位开局状态兜底。
  const draft: Draft = isRecord(raw) ? { ...raw } : { ...initialState([]) };
  let version = typeof draft.stateVersion === "number" ? draft.stateVersion : 0;
  for (const migration of MIGRATIONS) {
    if (version >= migration.to) continue;
    migration.run(draft, ctx);
    version = migration.to;
  }
  ensureCurrentFields(draft);
  normalizeOnLoad(draft, ctx);
  return parseGameState(draft);
}
