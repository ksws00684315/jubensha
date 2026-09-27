import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedScript, seats1h2a, setupIntEnv, teardownIntEnv, truncateAll } from "@/test/int";
import { db } from "@/lib/db";
import { chat } from "@/core/llm/client";
import { BudgetExceededError, resetBudgetCache, startOfLocalDay } from "@/core/llm/budget";
import { GameEngine } from "./engine";
import { availableLocations } from "./search-deal";
import type { GameState } from "./types";

/**
 * L3 I11：每日 LLM token 预算熔断（S3.2）。
 *
 * 本文件**不 mock** `@/core/llm/client`：要验的正是真实入口的第一行守卫，
 * 以及「超预算 → 引擎降级 → 对局照样到 ENDED」。为守住「除 R8 外不打真实模型」，
 * 全程把 fetch 换成必然失败的探针——熔断生效时它一次都不会被调用。
 */
const HUMAN = 0;
const YESTERDAY = new Date(startOfLocalDay().getTime() - 3600_000);

function fetchProbe() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("I11 不该发出任何网络请求");
  });
}

async function seedUsage(totalTokens: number, createdAt: Date): Promise<void> {
  await db.usageLog.create({
    data: { providerName: "mock", modelId: "mock-model", purpose: "player", totalTokens, promptTokens: totalTokens, createdAt },
  });
}

async function usageRows(totalToday: number): Promise<void> {
  await seedUsage(totalToday, new Date());
}

const chatOpts = { purpose: "player" as const, messages: [{ role: "user" as const, content: "说一句台词" }] };

async function startTestRoom(code: string): Promise<GameEngine> {
  const script = await seedScript();
  const scriptRow = await db.script.findUnique({ where: { id: script.id } });
  const room = await db.room.create({
    data: {
      code,
      scriptId: script.id,
      status: "lobby",
      hostToken: "host-token-1",
      seats: {
        create: seats1h2a().map((s, index) => ({
          index,
          kind: s.kind,
          characterId: s.characterId,
          playerName: s.kind === "human" ? "真人大佬" : null,
          token: s.kind === "human" ? "seat-token-1" : null,
        })),
      },
    },
    include: { seats: true },
  });
  return GameEngine.start(room as never, { id: script.id, content: scriptRow!.content });
}

function publicClueIds(state: GameState): string[] {
  return Object.entries(state.clueStates)
    .filter(([, c]) => c.isPublic)
    .map(([id]) => id)
    .slice(0, 3);
}

/** 真人座位按阶段前置条件出手（与 scripts/smoke-m3.mjs 同一套判据，改成进程内驱动）。 */
async function driveHumanToEnded(engine: GameEngine, timeoutMs: number): Promise<string[]> {
  const trail: string[] = [];
  const failures: string[] = [];
  const act = async (action: Record<string, unknown>) => {
    const r = await engine.handleAction(HUMAN, action as never);
    if (!r.ok) failures.push(`${JSON.stringify(action)} → ${r.error}`);
    return r;
  };
  const t0 = Date.now();
  let lastTag = "";
  let spoke = 0;
  while (Date.now() - t0 < timeoutMs) {
    const s = engine.state;
    if (s.phase === "ENDED") return trail;
    const tag = `${s.phase} r${s.round}`;
    if (tag !== lastTag) {
      trail.push(tag);
      lastTag = tag;
    }
    if (s.pendingAnswer?.toSeat === HUMAN) {
      await act({ type: "speak", text: "这个问题我记下了，先把已知的情况说清楚。" });
    } else if (s.phase === "READING" && !s.readySeats.includes(HUMAN)) {
      await act({ type: "ready" });
    } else if (s.phase === "SEARCH") {
      const pending = s.pendingPublish[String(HUMAN)] ?? [];
      if (pending.length) {
        for (const clueId of pending) await act({ type: "publish", clueId, publish: false });
      } else if (!s.searchChoices[String(HUMAN)]) {
        const locs = availableLocations(engine, HUMAN);
        if (locs.length) await act({ type: "choose_location", location: locs[0] });
      }
    } else if (s.phase === "VOTE" && !s.votes[String(HUMAN)]) {
      // VOTE 阶段 turnSeat 也停在真人身上，但此时要投的是票不是话，所以这一支必须在 turnSeat 分支之前
      const evidenceIds = publicClueIds(s);
      await act({
        type: "vote",
        target: 1,
        reason: "综合讨论与线索，此人的疑点最大",
        ...(evidenceIds.length ? { evidenceIds } : {}),
      });
    } else if (s.turnSeat === HUMAN) {
      if (s.phase === "SELF_INTRO" || s.phase === "DISCUSSION") {
        spoke += 1;
        await act({ type: "speak", text: `第 ${spoke} 次发言：案发时段我的行踪有据可查，倒是${s.round} 轮里几位的话没对上。` });
        if (engine.state.turnSeat === HUMAN) await act({ type: "skip" });
      } else {
        await act({ type: "skip" });
      }
    }
    await act({ type: "rush" });
    await new Promise((r) => setTimeout(r, 250));
  }
  const st = engine.state;
  throw new Error(
    `真人侧驱动超时，未到 ENDED。阶段轨迹：${trail.join(" → ")}；votes=${JSON.stringify(Object.keys(st.votes))}；turnSeat=${st.turnSeat}；ready=${JSON.stringify(st.readySeats)}；spoken=${JSON.stringify(st.spokenSeats)}；search=${JSON.stringify(st.searchChoices)}；失败动作：${failures.slice(-8).join(" | ")}`
  );
}

beforeEach(async () => {
  await setupIntEnv();
  await truncateAll();
  resetBudgetCache();
});

afterEach(async () => {
  await teardownIntEnv();
  resetBudgetCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("L3：每日 token 预算熔断（I11）", () => {
  it("真实 usage_logs 当日合计达到预算 → chat 抛 BudgetExceededError，且不走到模型请求", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const probe = fetchProbe();
    await usageRows(1200);
    await expect(chat(chatOpts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(probe).not.toHaveBeenCalled();
  });

  it("只按服务器本地时区的当天求和：昨天的量不计入，chat 继续走到原有降级", async () => {
    vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "1000");
    const probe = fetchProbe();
    await seedUsage(9_999, YESTERDAY);
    await usageRows(10);
    // 未超预算 → 走到 resolveBinding；测试库里没有任何模型绑定，说明熔断没有误拦、也没有发出请求
    await expect(chat(chatOpts)).rejects.toThrow(/尚未绑定模型/);
    expect(probe).not.toHaveBeenCalled();
  });

  it(
    "I11 超预算的对局照样走到 ENDED：AI 发言降级为提示，真人流程与结算不受影响",
    async () => {
      vi.stubEnv("LLM_DAILY_TOKEN_BUDGET", "500");
      const probe = fetchProbe();
      await usageRows(501);
      const engine = await startTestRoom("BUD001");
      const trail = await driveHumanToEnded(engine, Number(process.env.I11_DRIVE_MS ?? 150_000));

      expect(engine.state.phase).toBe("ENDED");
      expect(engine.state.voteResult).not.toBeNull();
      // 不是「直接落到 ENDED」，而是逐个阶段走完
      expect(trail.join(" → ")).toMatch(/READING.*SELF_INTRO.*SEARCH.*DISCUSSION.*VOTE.*$/);
      // 熔断的可见结果：AI 座位的发言被降级成公开提示（与「未绑定模型」同一条路径）
      const notices = engine.events.filter((e) => e.type === "system" && String(e.content.text ?? "").includes("思考时遇到问题"));
      expect(notices.length).toBeGreaterThan(0);
      expect(String(notices[0].content.text)).toContain("预算已用尽");
      expect(probe).not.toHaveBeenCalled();
      // 真人侧全程可玩：至少完成过自我介绍与两轮讨论发言
      const humanSpeeches = engine.events.filter((e) => e.type === "speech" && e.fromSeat === HUMAN);
      expect(humanSpeeches.length).toBeGreaterThanOrEqual(2);
    },
    240_000
  );
});
