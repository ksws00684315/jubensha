/* R3 SSE 断线续传实机：断开→产生新事件→Last-Event-ID 重连，验证 seq 连续、不重不漏。 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const cfg = JSON.parse(readFileSync(path.join(ROOT, ".e2e", "up.json"), "utf8"));
const BASE = `http://127.0.0.1:${cfg.port}`;
const log = (...a) => console.log("[e2e:sse-resume]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const post = (p, body, extraHeaders = {}) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).then((r) => r.json());

/** 收集 SSE 事件帧（kind=event），返回 EngineEvent[]；超时后 abort。 */
async function collectEvents(query, ms, headers = {}) {
  const ac = new AbortController();
  const events = [];
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${BASE}/api/games/${gameId}/events${query}`, {
      headers,
      signal: ac.signal,
    });
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
        if (m) {
          const parsed = JSON.parse(m[1]);
          if (parsed.kind === "event") events.push(parsed.event);
        }
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(t);
  }
  return events;
}

let gameId = "";

async function createHumanDmGame() {
  const scripts = await fetch(`${BASE}/api/scripts`).then((r) => r.json());
  const sample = scripts.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5);
  if (!sample) throw new Error("没有可用剧本");
  const seats = Array.from({ length: Math.max(3, sample.minPlayers) }, (_, i) => ({ kind: i === 0 ? "human" : "ai" }));
  const room = await post("/api/rooms", { scriptId: sample.id, seats, humanDm: true }, { "x-admin-token": cfg.adminToken });
  if (!room.code) throw new Error("建房失败: " + JSON.stringify(room));
  await post("/api/rooms/join", { code: room.code, name: "R3真人" });
  const dmJoin = await post("/api/rooms/dm-join", { code: room.code, name: "R3主持" });
  const start = await post(`/api/rooms/${room.code}/start`, { hostToken: room.hostToken });
  if (!start.gameId) throw new Error("开局失败: " + JSON.stringify(start));
  gameId = start.gameId;
  return { dmToken: dmJoin.token };
}

const narrate = (token, text) => post(`/api/games/${gameId}/dm-actions`, { token, action: { type: "narrate", text } });

async function main() {
  const { dmToken } = await createHumanDmGame();
  log("game", gameId);

  // 流 A：全量回放（含 hello 后的窗口），得到 DB 等价的 seq 全集
  const fullList = (await collectEvents("?lastSeq=0", 8_000)).map((e) => e.seq);
  const lastSeen = fullList.at(-1);
  log(`全量回放 ${fullList.length} 条，lastSeq=${lastSeen}`);
  if (!fullList.length) throw new Error("回放为空：SSE 流未建立");

  // 断线窗口：产生 3 条新事件
  for (let i = 1; i <= 3; i++) {
    const r = await narrate(dmToken, `R3 断线期间旁白 ${i}`);
    if (!r.ok) throw new Error("narrate 失败: " + JSON.stringify(r));
    await sleep(400);
  }

  // 流 B：带 Last-Event-ID 重连 → 只补断线之后的事件
  const resumed = (await collectEvents("?lastSeq=0", 7_000, { "last-event-id": String(lastSeen) })).map((e) => e.seq);
  log(`重连补传 ${resumed.length} 条`);
  if (!resumed.length) throw new Error("重连后没有补传任何事件");

  // 流 C：再次全量，作为 DB 等价参照
  const dbList = (await collectEvents("?lastSeq=0", 8_000)).map((e) => e.seq);

  // 断言 1：补传严格递增
  for (let i = 1; i < resumed.length; i++) {
    if (BigInt(resumed[i - 1]) >= BigInt(resumed[i])) throw new Error(`补传 seq 非递增: ${resumed[i - 1]} >= ${resumed[i]}`);
  }
  // 断言 2：补传全部 > lastSeen，且与 DB 全集在 (lastSeen, max(resumed)] 区间完全一致（不重不漏）
  const dbAfter = dbList.filter((s) => BigInt(s) > BigInt(lastSeen) && BigInt(s) <= BigInt(resumed.at(-1)));
  if (dbAfter.join(",") !== resumed.join(",")) {
    throw new Error(`补传与 DB 不一致\n补传: ${resumed.join(",")}\nDB:   ${dbAfter.join(",")}`);
  }
  log("seq 严格递增 ✓ 与 DB 全集一致（不重不漏）✓");
  log("R3 PASSED");
}

main().catch((e) => {
  console.error("[e2e:sse-resume] FAILED:", e.message);
  process.exit(1);
});
