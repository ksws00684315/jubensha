/* R2 鉴权负向实机：无口令建含 AI 座位的房（D2 admin 策略）/ 错 token 发 action / 观战 SSE 只见公开 /
 * 无口令访问管理接口 / 伪造 Host 访问 providers。
 * 需要 up.mjs 已启动实例（读 .e2e/up.json）。 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const cfg = JSON.parse(readFileSync(path.join(ROOT, ".e2e", "up.json"), "utf8"));
const BASE = `http://127.0.0.1:${cfg.port}`;
const ADMIN_TOKEN = cfg.adminToken;
const log = (...a) => console.log("[e2e:auth]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body, headers = {}) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

async function createHumanDmGame() {
  const scripts = await fetch(`${BASE}/api/scripts`).then((r) => r.json());
  const sample = scripts.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5);
  if (!sample) throw new Error("没有可用剧本");
  const seats = Array.from({ length: Math.max(3, sample.minPlayers) }, (_, i) => ({ kind: i === 0 ? "human" : "ai" }));
  const room = await post("/api/rooms", { scriptId: sample.id, seats, humanDm: true }, { "x-admin-token": ADMIN_TOKEN }).then((r) => r.json());
  const join = await post("/api/rooms/join", { code: room.code, name: "R2真人" }).then((r) => r.json());
  const dmJoin = await post("/api/rooms/dm-join", { code: room.code, name: "R2主持" }).then((r) => r.json());
  const start = await post(`/api/rooms/${room.code}/start`, { hostToken: room.hostToken }).then((r) => r.json());
  if (!start.gameId) throw new Error("开局失败: " + JSON.stringify(start));
  return { gameId: start.gameId, seat: join, dm: dmJoin, code: room.code };
}

/** 建流并收集 SSE data 帧；abort 后返回收集结果。 */
async function collectStream(url, ms, headers = {}) {
  const ac = new AbortController();
  const frames = [];
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(BASE + url, { headers, signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = frame.match(/^data: (.*)$/m);
        if (m) frames.push(JSON.parse(m[1]));
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(t);
  }
  return frames;
}

async function main() {
  // 0) 生产构建的实例默认 ROOM_CREATE_POLICY=admin（决策 D2，S3.1）：
  //    未带口令建含 AI 座位的房间 → 403；纯真人房不受策略影响 → 201。
  const list = await fetch(`${BASE}/api/scripts`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
  const probe = list.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5);
  if (!probe) throw new Error("没有可用于建房检查的剧本");
  const noCred = await post("/api/rooms", { scriptId: probe.id, seats: [{ kind: "ai" }, { kind: "ai" }, { kind: "ai" }] });
  log("无口令建 AI 房 →", noCred.status);
  if (noCred.status !== 403) throw new Error(`期望 403，实际 ${noCred.status}`);
  const deniedBody = await noCred.json();
  if (deniedBody.error !== "创建含 AI 座位的房间需要管理员身份") throw new Error(`403 文案不符: ${JSON.stringify(deniedBody)}`);
  const humanRoom = await post(
    "/api/rooms",
    { scriptId: probe.id, seats: Array.from({ length: Math.max(3, probe.minPlayers) }, () => ({ kind: "human" })) }
  );
  log("无口令建纯真人房 →", humanRoom.status);
  if (humanRoom.status !== 201) throw new Error(`纯真人房不该被策略拦住，实际 ${humanRoom.status}`);

  const { gameId, seat, dm } = await createHumanDmGame();
  log("game", gameId);

  // 1) 错 token 发 action → 403
  const bad = await post(`/api/games/${gameId}/actions`, { seatIndex: 0, token: "wrong-token", action: { type: "ready" } });
  log("错 token action →", bad.status);
  if (bad.status !== 403) throw new Error(`期望 403，实际 ${bad.status}`);

  // 2) SSE：观战流只见公开；座位 0 流可见发给自己的私有事件。
  //    DM 的 force_ready 会产生 visibility=seat:0 的系统事件（读本阶段即可确定触发）。
  const spectator = collectStream(`/api/games/${gameId}/events?lastSeq=0`, 12_000);
  const authed = collectStream(`/api/games/${gameId}/events?lastSeq=0&seat=0&token=${seat.token}`, 12_000);
  await sleep(2000);
  const PRIVATE_MARK = "已代座位1完成读本确认";
  const forced = await post(`/api/games/${gameId}/dm-actions`, { token: dm.token, action: { type: "force_ready", seatIndex: 0 } });
  log("DM force_ready →", forced.status);
  if (forced.status !== 200) throw new Error("DM force_ready 失败: " + JSON.stringify(await forced.json()));
  const specFrames = await spectator;
  const authFrames = await authed;
  const specTexts = specFrames.map((f) => JSON.stringify(f)).join("");
  const authTexts = authFrames.map((f) => JSON.stringify(f)).join("");
  if (!authTexts.includes(PRIVATE_MARK)) {
    throw new Error("座位 0 流未收到发给自己的私有事件（鉴权视角失效？）");
  }
  if (specTexts.includes(PRIVATE_MARK)) {
    throw new Error("观战流收到了 seat:0 私有事件（信息泄露！）");
  }
  if (!specFrames.some((f) => f.kind === "event")) {
    throw new Error("观战流连公开事件都没收到（流建立失败？）");
  }
  log("观战流只见公开事件 ✓，座位流可见私有 ✓");

  // 3) 无口令访问管理接口 → 401
  const noAuth = await fetch(`${BASE}/api/providers`, { signal: AbortSignal.timeout(10_000) });
  log("无口令 /api/providers →", noAuth.status);
  if (noAuth.status !== 401) throw new Error(`期望 401，实际 ${noAuth.status}`);

  // 4) 伪造 Host: localhost + XFF: 127.0.0.1（生产模式必须无效）→ 401
  const forged = await fetch(`${BASE}/api/providers`, {
    headers: { Host: "localhost", "X-Forwarded-For": "127.0.0.1" },
    signal: AbortSignal.timeout(10_000),
  });
  log("伪造 Host providers →", forged.status);
  if (forged.status !== 401) throw new Error(`期望 401，实际 ${forged.status}`);

  log("R2 PASSED");
}

main().catch((e) => {
  console.error("[e2e:auth] FAILED:", e.message);
  process.exit(1);
});
