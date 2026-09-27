/* R3 SSE 断线续传实机：断开→产生新事件→Last-Event-ID 重连，验证 seq 连续、不重不漏。
   S3.5 起附加票据路径：座位/主持的长期 token 不再进 SSE 地址，改为一次性 ticket 建连，
   并顺带核销「重复使用被拒」「兼容期旧 query 仍可用且日志不外泄凭证」。 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const cfg = JSON.parse(readFileSync(path.join(ROOT, ".e2e", "up.json"), "utf8"));
const BASE = `http://127.0.0.1:${cfg.port}`;
const LOG_FILE = cfg.log || path.join(ROOT, ".e2e", "instance.log");
const log = (...a) => console.log("[e2e:sse-resume]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logSize = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").length : 0);
const logSince = (offset) => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").slice(offset) : "");

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
  const joined = await post("/api/rooms/join", { code: room.code, name: "R3真人" });
  const dmJoin = await post("/api/rooms/dm-join", { code: room.code, name: "R3主持" });
  const start = await post(`/api/rooms/${room.code}/start`, { hostToken: room.hostToken });
  if (!start.gameId) throw new Error("开局失败: " + JSON.stringify(start));
  gameId = start.gameId;
  return { dmToken: dmJoin.token, seatIndex: joined.seatIndex, seatToken: joined.token };
}

/** 换一张 SSE 一次性票据：长期凭证只走请求头，不进 URL。 */
async function exchangeTicket(headers, body) {
  const res = await fetch(`${BASE}/api/games/${gameId}/stream-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`换票失败 ${res.status}：${JSON.stringify(await res.json().catch(() => null))}`);
  const { ticket } = await res.json();
  if (!/^[0-9a-f]{32}$/.test(String(ticket))) throw new Error(`换票响应里没有票据：${JSON.stringify(ticket)}`);
  return String(ticket);
}

const assertIncreasing = (seqs, label) => {
  for (let i = 1; i < seqs.length; i++) {
    if (BigInt(seqs[i - 1]) >= BigInt(seqs[i])) throw new Error(`${label} seq 非递增: ${seqs[i - 1]} >= ${seqs[i]}`);
  }
};

const narrate = (token, text) => post(`/api/games/${gameId}/dm-actions`, { token, action: { type: "narrate", text } });

async function main() {
  const { dmToken, seatIndex, seatToken } = await createHumanDmGame();
  log("game", gameId);
  if (seatIndex === null || seatIndex === undefined || !seatToken) throw new Error("入局未拿到座位凭证");

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
  assertIncreasing(resumed, "补传");
  // 断言 2：补传全部 > lastSeen，且与 DB 全集在 (lastSeen, max(resumed)] 区间完全一致（不重不漏）
  const dbAfter = dbList.filter((s) => BigInt(s) > BigInt(lastSeen) && BigInt(s) <= BigInt(resumed.at(-1)));
  if (dbAfter.join(",") !== resumed.join(",")) {
    throw new Error(`补传与 DB 不一致\n补传: ${resumed.join(",")}\nDB:   ${dbAfter.join(",")}`);
  }
  log("seq 严格递增 ✓ 与 DB 全集一致（不重不漏）✓");

  // —— 以下为 S3.5 附加：一次性票据建连（长期 token 不再出现在 SSE 地址里）——

  // 先取一次匿名公开全集作为参照，再建座位票流：座位视图必须是它的超集
  const publicNow = (await collectEvents("?lastSeq=0", 5_000)).map((e) => e.seq);
  const seatTicket = await exchangeTicket({ "x-seat-token": seatToken }, { seat: seatIndex });
  const seatQuery = `?${new URLSearchParams({ ticket: seatTicket, lastSeq: "0" })}`;
  if (seatQuery.includes("token=")) throw new Error("座位票建流地址里出现了 token=");
  const viaTicket = (await collectEvents(seatQuery, 6_000)).map((e) => e.seq);
  if (!viaTicket.length) throw new Error("ticket 建流后没有收到任何事件");
  assertIncreasing(viaTicket, "座位票流");
  const missing = publicNow.filter((s) => !viaTicket.includes(s));
  if (missing.length) throw new Error(`座位票流丢了公开事件：${missing.join(",")}`);
  log(`ticket 建流 ✓ 收到 ${viaTicket.length} 条（公开全集 ${publicNow.length} 条全部覆盖），地址无 token= ✓`);

  const dmTicket = await exchangeTicket({ "x-dm-token": dmToken }, { dm: true });
  const viaDm = (await collectEvents(`?${new URLSearchParams({ ticket: dmTicket, lastSeq: "0" })}`, 6_000)).map((e) => e.seq);
  if (!viaDm.length) throw new Error("DM ticket 建流后没有收到任何事件");
  assertIncreasing(viaDm, "主持票流");
  log(`DM ticket 建流 ✓ 收到 ${viaDm.length} 条`);

  // 一次性：同一张座位票再用一次必须被拒（服务端降级为纯观战并记一行日志）
  const reusedMark = logSize();
  await collectEvents(`?${new URLSearchParams({ ticket: seatTicket, lastSeq: "0" })}`, 4_000);
  const reusedLog = logSince(reusedMark);
  if (!reusedLog.includes("ticket 无效")) throw new Error("重复使用 ticket 没有被拒绝（实例日志无降级记录）");
  log("ticket 用后即废 ✓（服务端已按未鉴权降级）");

  // 兼容期：旧的 token query 仍然可用，但要留下 deprecation 日志，且日志里不得出现凭证明文
  const legacyMark = logSize();
  const legacyQuery = `?${new URLSearchParams({ seat: String(seatIndex), token: seatToken, lastSeq: "0" })}`;
  const viaLegacy = (await collectEvents(legacyQuery, 6_000)).map((e) => e.seq);
  if (!viaLegacy.length) throw new Error("兼容期 token query 建流失败");
  const legacyMissing = publicNow.filter((s) => !viaLegacy.includes(s));
  if (legacyMissing.length) throw new Error(`兼容期路径丢了公开事件：${legacyMissing.join(",")}`);
  const legacyLog = logSince(legacyMark);
  if (!legacyLog.includes("已废弃的 query 凭证")) throw new Error("兼容期路径没有记 deprecation 日志");
  if (legacyLog.includes(seatToken)) throw new Error("deprecation 日志泄露了座位 token 明文");
  log("兼容期 token query 仍可用 ✓ 且已记废弃告警（日志无凭证明文）");

  log("R3 PASSED");
}

main().catch((e) => {
  console.error("[e2e:sse-resume] FAILED:", e.message);
  process.exit(1);
});
