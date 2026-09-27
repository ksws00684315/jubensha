/* R5 多实例单写者（S4.1）：同一个 jubensha_e2e 库上再起一个生产实例，两个实例都用座位 token
 * 打 GET /api/games/[id] 触发懒恢复，验证两件事：
 *   A. 单写者：只有开局那个实例在驱动。非持牌实例以只读视图加载（日志 `lease held by`），
 *      而且它对同一局的 HTTP 动作一律被拒（「对局由其他实例主持，请刷新」），事件纹丝不动；
 *   B. 交接：停掉持牌实例（SIGTERM）后另一实例 1s 内取牌，并把这一局跑到 ENDED。
 * 全程检查事件流的「不可重复」不变量——双驱动的签名就是同一条内容被写第二遍。
 *
 * 为什么不变量不是「每轮每人一条 speech」：e2e 库刻意不绑模型（见下面 ai_providers 检查），
 * AI 座位不发 speech，只留一行「思考时遇到问题」的 system 事件。所以重复检测落在
 * 真人发言、阶段横幅/幕旁白、线索发现与公示这几类必然产生的写上。
 *
 * 用法：node scripts/e2e/dual-instance.mjs        （前置 npm run e2e:up，全新库）
 *      node scripts/e2e/dual-instance.mjs --phase=a   # 只跑 A 段
 * 结束后主实例会被 B 段停掉：用 npm run e2e:up -- --keep-db 复原。
 * 座位 token 只写 .e2e/r5-state.json（已 gitignore），不打印。 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const E2E_DIR = path.join(ROOT, ".e2e");
const LOG1 = path.join(E2E_DIR, "instance.log");
const LOG2 = path.join(E2E_DIR, "instance2.log");
const STATE_FILE = path.join(E2E_DIR, "r5-state.json");
const onlyA = process.argv.includes("--phase=a");

const cfg = JSON.parse(readFileSync(path.join(E2E_DIR, "up.json"), "utf8"));
const PORT1 = Number(cfg.port);
if (PORT1 === 3000) die("拒绝：主实例端口是 3000（用户进程）");
const BASE1 = `http://127.0.0.1:${PORT1}`;
const DB = String(cfg.db);

function die(msg) {
  console.error("[e2e:r5] FAILED:", msg);
  process.exit(1);
}
const log = (...a) => console.log("[e2e:r5]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sql(q) {
  const r = spawnSync("psql", [DB, "-At", "-c", q], { encoding: "utf8" });
  if (r.status !== 0) die("psql 失败：" + (r.stderr || "").trim().slice(0, 200));
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));
}
const one = (q) => sql(q)[0]?.[0];
function isPortFree(port) {
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

/** 实例日志是 append 模式、跨多次运行复用：只看本轮从 offset 之后新写的那一段。 */
const sizeOf = (f) => (existsSync(f) ? statSync(f).size : 0);
const tailFrom = (f, off) => (off === 0 ? readFileSync(f, "utf8") : readFileSync(f, "utf8").slice(off));

const post = (base, p, body, extraHeaders = {}) =>
  fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
    .then((r) => r.json())
    .catch(() => ({}));

/* ---------- 起第二实例 ---------- */
const PORT2 = [PORT1 + 1, 3101, 3111, 3121, 3131, 3141].find((p) => p !== 3000 && isPortFree(p));
if (!PORT2) die("找不到可用于第二实例的端口");
const BASE2 = `http://127.0.0.1:${PORT2}`;
mkdirSync(E2E_DIR, { recursive: true });

// 第二实例用同一个 .e2e/app.json，但 SECRET_MASTER_KEY 是新进程自己生成的：
// 库里若已有 provider（密钥按主实例的 master key 加密），它就解不开了 —— R5 只跑无模型链路，直接拒绝。
if (one("select count(*) from ai_providers;")[0] !== "0") die("R5 需要全新 e2e 库：ai_providers 非空，第二实例的 master key 解不开既有密钥");

const ENV = {
  ...process.env,
  PORT: String(PORT2),
  HOSTNAME: "127.0.0.1",
  NODE_ENV: "production",
  APP_CONFIG_PATH: path.join(E2E_DIR, "app.json"),
  DATABASE_URL: DB,
  ADMIN_TOKEN: String(cfg.adminToken),
  SECRET_MASTER_KEY: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
};
for (const key of Object.keys(ENV)) if (key.startsWith("JEV_")) delete ENV[key];
ENV.JEV_SHADOW = "0";
ENV.JEV_FALLBACK = "0";

const log2Offset = sizeOf(LOG2);
const fd = openSync(LOG2, "a");
const child2 = spawn("npx", ["next", "start", "-p", String(PORT2), "-H", "127.0.0.1"], {
  cwd: ROOT,
  env: ENV,
  stdio: ["ignore", fd, fd],
  detached: true,
});
closeSync(fd);
child2.unref();
log(`第二实例 pid=${child2.pid} port=${PORT2} 日志=${path.relative(ROOT, LOG2)}`);

async function waitReady(base) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/scripts`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return false;
}
if (!(await waitReady(BASE2))) die(`第二实例 90s 内未就绪，见 ${path.relative(ROOT, LOG2)}`);
log("第二实例就绪");

function stopInstance2() {
  if (child2.pid) execSync(`kill -- -${child2.pid} 2>/dev/null || kill ${child2.pid} 2>/dev/null || true`, { stdio: "pipe" });
}
process.on("exit", stopInstance2);

/* ---------- 开局：主实例建房 + 入座 + 开局 ---------- */
const log1Offset = sizeOf(LOG1);
const scripts = await fetch(`${BASE1}/api/scripts`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
const sample = Array.isArray(scripts) ? scripts.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5) : null;
if (!sample) die("没有 5 人本可用（先 npm run e2e:up 导种子）");
const seatCount = Math.max(3, sample.minPlayers);
const seats = Array.from({ length: seatCount }, (_, i) => ({ kind: i === 0 ? "human" : "ai" }));
const room = await post(BASE1, "/api/rooms", { scriptId: sample.id, seats }, { "x-admin-token": cfg.adminToken });
if (!room.code) die("建房失败: " + JSON.stringify(room).slice(0, 200));
const join = await post(BASE1, "/api/rooms/join", { code: room.code, name: "R5真人" });
if (!join.token) die("入座失败: " + JSON.stringify(join).slice(0, 200));
const started = await post(BASE1, `/api/rooms/${room.code}/start`, { hostToken: room.hostToken });
if (!started.gameId) die("开局失败: " + JSON.stringify(started).slice(0, 200));
const gameId = started.gameId;
const seatIndex = join.seatIndex;
const token = join.token;
writeFileSync(STATE_FILE, JSON.stringify({ gameId, seatIndex, token, port1: PORT1, port2: PORT2 }, null, 2) + "\n");
log("新局", gameId, sample.title, "座位=", seatCount, "真人在", seatIndex);

const EV = `"gameId"='${gameId}'`;
const status = (base) =>
  fetch(`${base}/api/games/${gameId}?seat=${seatIndex}&token=${token}`, { signal: AbortSignal.timeout(30_000) })
    .then((r) => r.json())
    .catch((e) => ({ error: String(e) }));
const actOn = (base, action) => post(base, `/api/games/${gameId}/actions`, { seatIndex, token, action });
const eventCount = () => Number(one(`select count(*) from game_events where ${EV};`));

const PHASE_ORDER = ["LOBBY", "READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"];
const phaseIdx = (p) => PHASE_ORDER.indexOf(p);

/* ---------- 事件流不变量 ---------- */
/**
 * 双驱动会把这些「一局里每个位置只该出现一次」的写成两遍。
 * 无模型时 AI 不发 speech，所以真人发言、阶段横幅/幕旁白、线索发现与公示是必到的样本。
 */
const DUP_QUERIES = [
  ["同一座位同一阶段两条发言", `select 'r'||round||'|'||phase||'|seat'||"fromSeat"||'|'||count(*) from game_events where ${EV} and type='speech' group by round, phase, "fromSeat" having count(*)>1;`],
  [
    "阶段横幅/幕旁白重复",
    `select 'r'||round||'|'||phase||'|'||left(content->>'text',24)||'|'||count(*) from game_events where ${EV} and type='phase' group by round, phase, left(content->>'text',24) having count(*)>1;`,
  ],
  [
    "同一条线索被记了两遍",
    `select 'r'||round||'|seat'||"fromSeat"||'|'||(content->>'clueId')||'|'||coalesce(content->>'publicBy','发现')||'|'||count(*) from game_events where ${EV} and type='clue' group by round, "fromSeat", (content->>'clueId'), coalesce(content->>'publicBy','发现') having count(*)>1;`,
  ],
];
function checkInvariants(stage) {
  for (const [name, q] of DUP_QUERIES) {
    const rows = sql(q);
    if (rows.length) die(`${stage}出现${name}：${rows.flat().join(" / ")}`);
  }
  const seqBad = one(`select count(*) from (select seq, row_number() over (order by seq) as rn from game_events where ${EV}) t where seq <> rn + (select min(seq) from game_events where ${EV}) - 1;`);
  if (Number(seqBad) !== 0) die(`${stage}事件 seq 不连续（空洞或重复）：${seqBad} 处`);
  const total = Number(one(`select count(*) from game_events where ${EV};`));
  const distinct = Number(one(`select count(distinct seq) from game_events where ${EV};`));
  if (total !== distinct) die(`${stage}seq 有重复：${distinct}/${total}`);
  log(`${stage}不变量通过：事件 ${total} 条，seq 连续无重复；发言/横幅/线索均无二遍`);
}

/** 真人该做的动作（与 R4 的自动驾驶同一套取舍）。 */
let lastActAt = 0;
let clueSeen = 0;
async function driveOnce(base, g) {
  if (g.error) die("读取对局失败: " + JSON.stringify(g).slice(0, 200));
  if (g.pendingAnswer && g.pendingAnswer.toSeat === seatIndex) {
    await actOn(base, { type: "speak", text: "这个问题我记得的时间线稍后一起说，先把已知的讲清楚。" });
    return;
  }
  if (g.phase === "READING") return void (await actOn(base, { type: "ready" }));
  if (phaseIdx(g.phase) >= 5) {
    if (g.quiz?.questions?.length && !g.quiz?.myAnswers) {
      await actOn(base, { type: "answer_quiz", answers: g.quiz.questions.map((q) => ({ questionId: q.id, optionId: q.options[0].id })) });
      return;
    }
    if (g.voteMode !== "choice" && !g.voteResult) {
      const evidenceIds = (g.publicEvidence ?? []).slice(0, 3).map((c) => c.id);
      await actOn(base, { type: "vote", target: 3, reason: "综合讨论与线索，此人的疑点最大", ...(evidenceIds.length ? { evidenceIds } : {}) });
      return;
    }
    return;
  }
  if (g.turnSeat === seatIndex) {
    await actOn(base, { type: "speak", text: "我把已知的情况按时间顺序说一遍，请大家补充。" });
    const after = await status(base);
    if (after.turnSeat === seatIndex) await actOn(base, { type: "skip" });
    return;
  }
  if (g.phase === "SEARCH") {
    // 顺序照 smoke-m3：先把本轮地点选掉（不选，这一轮会一直等真人），
    // 再对手里新到手的卡做公开/私藏决定。政策强制公开的卡会被拒（「当前不能公开或私藏这张卡」），
    // 拒了就翻页——重试同一张卡会把这一轮饿死。
    const loc = (g.availableLocations ?? [])[0];
    if (loc) {
      const r = await actOn(base, { type: "choose_location", location: loc });
      if (!r.ok && !/已经选过/.test(r.error ?? "")) log(`  !! choose_location(${loc}) 被拒：${JSON.stringify(r).slice(0, 120)}`);
    }
    const fresh = (g.myClues ?? []).slice(clueSeen);
    for (const clueId of fresh) {
      const r = await actOn(base, { type: "publish", clueId, publish: false });
      if (!r.ok && !/当前不能公开或私藏/.test(r.error ?? "")) log(`  !! publish(${clueId}) 被拒：${JSON.stringify(r).slice(0, 120)}`);
    }
    clueSeen = Math.max(clueSeen, (g.myClues ?? []).length);
    return;
  }
  if (g.phase === "DISCUSSION" && Date.now() - lastActAt > 6000) {
    await actOn(base, { type: "rush" });
    lastActAt = Date.now();
  }
}

/* ---------- A 段：两个实例都带座位 token 打 GET，真人动作只发主实例 ---------- */
let probeDone = false;
const t0 = Date.now();
let lastTag = "";
let reachedVote = false;
while (Date.now() - t0 < 8 * 60_000) {
  const g1 = await status(BASE1); // 主实例：持牌者，触发懒恢复并驱动
  await status(BASE2); // 第二实例：同样带座位 token，应只读取牌失败 → 日志 lease held by
  const tag = `${g1.phase} r${g1.round} turn=${g1.turnSeat}`;
  if (tag !== lastTag) {
    log(tag);
    lastTag = tag;
  }

  // 轮到真人时，先拿同一个动作打到非持牌实例上：必须被拒，且事件流一点不动
  if (!probeDone && g1.phase !== "READING" && (g1.turnSeat === seatIndex || g1.phase === "SEARCH")) {
    probeDone = true;
    const before = eventCount();
    const rejected = await actOn(BASE2, { type: "skip" });
    const after = eventCount();
    if (rejected.ok !== false || rejected.error !== "对局由其他实例主持，请刷新") {
      die(`非持牌实例的动作没有被拒：${JSON.stringify(rejected).slice(0, 160)}`);
    }
    if (after !== before) die(`非持牌实例被拒之后仍然写了 ${after - before} 条事件`);
    log(`A 段只读拒绝探针通过：${JSON.stringify(rejected.error)}，事件 ${before} 条未变`);
  }

  if (phaseIdx(g1.phase) >= 5) {
    reachedVote = true;
    break;
  }
  await driveOnce(BASE1, g1);
  await sleep(2000);
}
if (!reachedVote) die(`8 分钟内没走到 VOTE（最后状态 ${lastTag}）`);
if (!probeDone) die("A 段没有做只读拒绝探针（真人从未轮到）");

const log2 = tailFrom(LOG2, log2Offset);
const log1 = tailFrom(LOG1, log1Offset);
const heldByLines = (log2.match(/lease held by/g) ?? []).length;
if (heldByLines < 2) die(`第二实例本轮日志里 \`lease held by\` 只有 ${heldByLines} 次：它没有持续以只读视图加载这一局`);
if (log1.includes("lease lost")) die("主实例本轮日志出现 `lease lost`：单写者被破坏了");
const owner1 = one(`select coalesce("ownerId",'(null)') from games where id='${gameId}';`);
if (owner1 === "(null)") die("A 段结束时主实例已不持牌");
const speechesA = Number(one(`select count(*) from game_events where ${EV} and type='speech';`));
log(`A 段通过：单写者（owner=${owner1.slice(0, 8)}），第二实例只读日志 ${heldByLines} 次，真人发言 ${speechesA} 条`);
checkInvariants("A 段");

if (onlyA) {
  stopInstance2();
  log("R5 A 段 PASSED（--phase=a，跳过接管段）");
  process.exit(0);
}

/* ---------- B 段：停掉持牌实例，看另一实例接管 ---------- */
const releaseT0 = Date.now();
// 与 down.mjs 同一手法：detached 起的进程是组长，杀进程组才能连带 next server
execSync(`kill -- -${cfg.pid} 2>/dev/null || kill ${cfg.pid} 2>/dev/null || true`, { stdio: "pipe" });
log(`主实例 pid=${cfg.pid} 已 SIGTERM`);
let releasedIn = -1;
let owner2 = owner1;
while (Date.now() - releaseT0 < 10_000) {
  owner2 = one(`select coalesce("ownerId",'(null)') from games where id='${gameId}';`);
  if (owner2 !== owner1) {
    releasedIn = Date.now() - releaseT0;
    break;
  }
  await sleep(50);
}
if (releasedIn < 0) {
  const alive = spawnSync("kill", ["-0", String(cfg.pid)], { stdio: "pipe" }).status === 0;
  const tail = tailFrom(LOG1, log1Offset).trim().split("\n").slice(-4).join(" ⏎ ");
  die(
    `主实例 SIGTERM 后 10s 内租约既没释放也没被接管（owner 仍是 ${owner1.slice(0, 8)}）` +
      `\n  主实例进程：${alive ? "还活着" : "已退出"}` +
      `\n  主实例本轮日志：${tail || "(无)"}`
  );
}
if (releasedIn > 1_000) die(`主实例 SIGTERM 后 ${releasedIn}ms 才交牌，超过 1s`);
log(`主实例停止，${releasedIn}ms 后租约交回（owner=${owner2 === "(null)" ? "无人" : owner2.slice(0, 8)}）`);

const eventsA = eventCount();
const t1 = Date.now();
let ended = false;
let finalG = null;
let lastTag2 = "";
while (Date.now() - t1 < 8 * 60_000) {
  const g2 = await status(BASE2); // 带座位 token 的 GET 才会触发懒恢复
  owner2 = one(`select coalesce("ownerId",'(null)') from games where id='${gameId}';`);
  const tag = `${g2.phase} r${g2.round} turn=${g2.turnSeat} owner=${owner2 === "(null)" ? "-" : owner2.slice(0, 8)}`;
  if (tag !== lastTag2) {
    log(tag);
    lastTag2 = tag;
  }
  if (g2.phase === "ENDED") {
    ended = true;
    finalG = g2;
    break;
  }
  await driveOnce(BASE2, g2);
  await sleep(2000);
}
if (!ended) die(`B 段 8 分钟内没走到 ENDED（最后状态 ${lastTag2}）`);
if (owner2 === owner1 || owner2 === "(null)") die(`B 段结束时持牌者不是第二实例：owner=${owner2}`);
if (!finalG.voteResult) die("ENDED 但 voteResult 为空");
checkInvariants("B 段（跨实例接管后）");
log(`B 段通过：第二实例接管，事件 ${eventsA} → ${eventCount()}，跑到 ENDED`);
log("R5 PASSED（主实例已被停掉，复原：npm run e2e:up -- --keep-db）");
process.exit(0);
