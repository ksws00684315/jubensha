/* R4 进程重启恢复：先用「真人自动驾驶」把一局推到轮到真人的 DISCUSSION（引擎停等），
 * 记录 phase/round 后退出；人工重启实例（保留库）再以 --stage=resume 续跑，
 * 断言恢复后的 phase/round 与重启前一致，并能推进到 ENDED。
 * 用法：
 *   node scripts/e2e/restart-resume.mjs                  # 开局并停等，写 .e2e/r4-state.json
 *   npm run e2e:down -- --keep-db && npm run e2e:up -- --keep-db
 *   node scripts/e2e/restart-resume.mjs --stage=resume   # 校验恢复并续跑到 ENDED
 * 座位 token 只落在 .e2e/（已 gitignore），不打印、不进日志。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const E2E_DIR = path.join(ROOT, ".e2e");
const STATE_FILE = path.join(E2E_DIR, "r4-state.json");
const resume = process.argv.includes("--stage=resume");

const cfg = JSON.parse(readFileSync(path.join(ROOT, ".e2e", "up.json"), "utf8"));
const BASE = `http://127.0.0.1:${cfg.port}`;
if (cfg.port === 3000) {
  console.error("拒绝：实例端口是 3000（用户进程）。");
  process.exit(1);
}
const log = (...a) => console.log("[e2e:r4]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = async (p, body, extraHeaders = {}) => {
  const res = await fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return res.json().catch(() => ({}));
};

const PHASE_ORDER = ["LOBBY", "READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"];
const phaseIdx = (p) => PHASE_ORDER.indexOf(p);

let gameId = "";
let seatIndex = 0;
let token = "";
const status = () => fetch(`${BASE}/api/games/${gameId}?seat=${seatIndex}&token=${token}`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
const act = (action) => post(`/api/games/${gameId}/actions`, { seatIndex, token, action });

async function newGame() {
  const scripts = await fetch(`${BASE}/api/scripts`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
  const sample = scripts.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5);
  if (!sample) throw new Error("没有 5 人本可用");
  const seats = Array.from({ length: Math.max(3, sample.minPlayers) }, (_, i) => ({ kind: i === 0 ? "human" : "ai" }));
  const room = await post("/api/rooms", { scriptId: sample.id, seats }, { "x-admin-token": cfg.adminToken });
  if (!room.code) throw new Error("建房失败: " + JSON.stringify(room));
  const join = await post("/api/rooms/join", { code: room.code, name: "R4真人" });
  if (!join.token) throw new Error("入座失败: " + JSON.stringify(join));
  const start = await post(`/api/rooms/${room.code}/start`, { hostToken: room.hostToken });
  if (!start.gameId) throw new Error("开局失败: " + JSON.stringify(start));
  gameId = start.gameId;
  seatIndex = join.seatIndex;
  token = join.token;
  mkdirSync(E2E_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ gameId, seatIndex, token }, null, 2) + "\n");
  log("新局", gameId, "座位", seatIndex);
}

function loadState() {
  if (!existsSync(STATE_FILE)) throw new Error("缺少 .e2e/r4-state.json，请先跑 --stage=open");
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  gameId = s.gameId;
  seatIndex = s.seatIndex;
  token = s.token;
  return s;
}

/** 按当前局面替真人走一步；返回是否发生了动作。 */
let lastActAt = 0;
const run = async (action) => {
  const r = await act(action);
  if (!r.ok && !/已经选过|已经投过|已作答/.test(r.error ?? "")) log("  !! action failed:", JSON.stringify(action), r.error);
  return r;
};
async function driveOnce(g) {
  if (g.error) throw new Error("读取对局失败: " + g.error);
  if (g.pendingAnswer && g.pendingAnswer.toSeat === seatIndex) {
    await run({ type: "speak", text: "这个问题我记得的时间线稍后一起说，先把已知的讲清楚。" });
    return true;
  }
  if (g.phase === "READING") {
    await run({ type: "ready" });
    return true;
  }
  // 投票/复盘答题优先于「轮到我发言」：VOTE 阶段 turnSeat 仍指向我，此时该出手的是票不是话
  if (phaseIdx(g.phase) >= 5) {
    if (g.quiz?.questions?.length && !g.quiz?.myAnswers) {
      await run({ type: "answer_quiz", answers: g.quiz.questions.map((q) => ({ questionId: q.id, optionId: q.options[0].id })) });
      return true;
    }
    if (g.voteMode !== "choice" && !g.voteResult) {
      const evidenceIds = (g.publicEvidence ?? []).slice(0, 3).map((c) => c.id);
      await run({ type: "vote", target: 3, reason: "综合讨论与线索，此人的疑点最大", ...(evidenceIds.length ? { evidenceIds } : {}) });
      return true;
    }
    return false;
  }
  if (g.turnSeat === seatIndex) {
    await run({ type: "speak", text: "我把已知的情况按时间顺序说一遍，请大家补充。" });
    const after = await status();
    if (after.turnSeat === seatIndex) await run({ type: "skip" });
    return true;
  }
  if (g.phase === "SEARCH") {
    const fresh = (g.myClues ?? []).slice(handoff.clueSeen);
    if (fresh.length) {
      for (const clueId of fresh) await run({ type: "publish", clueId, publish: false });
      handoff.clueSeen += fresh.length;
      return true;
    }
    const loc = (g.availableLocations ?? [])[0];
    if (loc) {
      const r = await run({ type: "choose_location", location: loc });
      if (r.ok) return true;
    }
    return false;
  }
  if (g.phase === "DISCUSSION" && Date.now() - lastActAt > 6000) {
    await act({ type: "rush" });
    lastActAt = Date.now();
    return true;
  }
  return false;
}

const handoff = { clueSeen: 0 };

async function main() {
  if (resume) {
    const before = loadState();
    handoff.clueSeen = before.clueSeen ?? 0;
    const g0 = await status();
    if (g0.error) throw new Error("读取对局失败: " + g0.error);
    if (before.phase && (g0.phase !== before.phase || g0.round !== before.round)) {
      throw new Error(`恢复后状态不一致：重启前 ${before.phase} r${before.round}，现在 ${g0.phase} r${g0.round}`);
    }
    log(`重启后首读核对一致：${g0.phase} r${g0.round} turn=${g0.turnSeat}`);
  } else {
    await newGame();
  }

  const t0 = Date.now();
  const stopAfter = resume ? 12 : 6; // 分钟
  let last = "";
  for (;;) {
    if (Date.now() - t0 > stopAfter * 60_000) throw new Error(`超时未到目标（${stopAfter} 分钟）`);
    const g = await status();
    const tag = `${g.phase} r${g.round} turn=${g.turnSeat}`;
    if (tag !== last) {
      log(tag);
      last = tag;
    }
    if (!resume && g.phase === "DISCUSSION" && g.round >= 1 && g.turnSeat === seatIndex) {
      writeFileSync(STATE_FILE, JSON.stringify({ gameId, seatIndex, token, phase: g.phase, round: g.round, clueSeen: (g.myClues ?? []).length }, null, 2) + "\n");
      log(`已停等并记录 ${g.phase} r${g.round}；请执行 e2e:down --keep-db && e2e:up --keep-db 后跑 --stage=resume`);
      return;
    }
    if (resume && g.phase === "ENDED") {
      if (!g.voteResult) throw new Error("ENDED 但 voteResult 为空");
      log("恢复后推进到 ENDED ✓ voteResult:", JSON.stringify(g.voteResult));
      log("R4 PASSED");
      return;
    }
    await driveOnce(g);
    await sleep(2000);
  }
}

main().catch((e) => {
  console.error("[e2e:r4] FAILED:", e.message);
  process.exit(1);
});
