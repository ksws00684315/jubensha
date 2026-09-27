/* R7：对隔离 e2e 实例采样四个非 LLM API，每个端点 200 次。 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const state = JSON.parse(readFileSync(path.join(ROOT, ".e2e", "up.json"), "utf8"));
const BASE = `http://127.0.0.1:${state.port}`;
const queryFile = path.join(ROOT, ".e2e", "query-timings.log");
const COUNT = 200;

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

async function request(url, init = {}, allowedStatuses = [200]) {
  const started = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const elapsed = performance.now() - started;
  const body = await response.json().catch(() => null);
  if (!allowedStatuses.includes(response.status)) {
    throw new Error(`R7 请求失败：${url.replace(BASE, "")}, HTTP ${response.status}`);
  }
  return { elapsed, body };
}

async function post(url, body, headers = {}, allowedStatuses = [200]) {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }, allowedStatuses);
}

async function setupGame() {
  const { body: scripts } = await request(`${BASE}/api/scripts`);
  const script = scripts.find((item) => item.minPlayers <= 5 && item.maxPlayers >= 5);
  if (!script) throw new Error("R7 找不到支持 5 人的已导入剧本");

  const { body: room } = await post(`${BASE}/api/rooms`, {
    scriptId: script.id,
    seats: Array.from({ length: 5 }, () => ({ kind: "human" })),
  }, { "x-admin-token": state.adminToken }, [201]);
  const players = [];
  for (let i = 0; i < 5; i++) {
    const { body: joined } = await post(`${BASE}/api/rooms/join`, { code: room.code, name: `R7玩家${i + 1}` });
    players.push({ seatIndex: joined.seatIndex, token: joined.token });
  }
  const { body: started } = await post(`${BASE}/api/rooms/${room.code}/start`, { hostToken: room.hostToken }, {}, [201]);
  for (const player of players) {
    await post(`${BASE}/api/games/${started.gameId}/actions`, {
      ...player,
      action: { type: "ready" },
    });
  }
  return { code: room.code, gameId: started.gameId, player: players[0] };
}

async function sample(name, fetchOne) {
  const elapsed = [];
  const statuses = new Map();
  writeFileSync(queryFile, "");
  for (let i = 0; i < COUNT; i++) {
    const result = await fetchOne(i);
    elapsed.push(result.elapsed);
    statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
  }
  const queryDurations = readFileSync(queryFile, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  const result = {
    endpoint: name,
    requests: COUNT,
    http: Object.fromEntries(statuses),
    apiMs: { p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95), p99: percentile(elapsed, 0.99), max: Math.max(...elapsed) },
    prismaQueryCount: queryDurations.length,
    prismaQueryMs: { p50: percentile(queryDurations, 0.5), p95: percentile(queryDurations, 0.95), p99: percentile(queryDurations, 0.99), max: queryDurations.length ? Math.max(...queryDurations) : null },
  };
  console.log(JSON.stringify(result));
  if (result.apiMs.p95 >= 300 || result.apiMs.p99 >= 500) throw new Error(`R7 延迟超标：${name}`);
  if (result.prismaQueryMs.p95 === null || result.prismaQueryMs.p95 >= 100) throw new Error(`R7 Prisma 查询 p95 超标或无采样：${name}`);
}

try {
  const { code, gameId, player } = await setupGame();
  const clientIp = (index) => ({ "x-forwarded-for": `198.51.100.${(index % 4) + 1}` });
  await sample("GET /api/scripts", async (i) => {
    const result = await request(`${BASE}/api/scripts`, { headers: clientIp(i) });
    return { ...result, status: 200 };
  });
  await sample("GET /api/rooms/[code]", async (i) => {
    const result = await request(`${BASE}/api/rooms/${code}`, { headers: clientIp(i) });
    return { ...result, status: 200 };
  });
  await sample("GET /api/games/[id]", async (i) => {
    const result = await request(`${BASE}/api/games/${gameId}?seat=${player.seatIndex}`, {
      headers: { "x-seat-token": player.token, ...clientIp(i) },
    });
    return { ...result, status: 200 };
  });
  await sample("POST /api/games/[id]/actions (skip)", async (i) => {
    const result = await post(`${BASE}/api/games/${gameId}/actions`, {
      ...player,
      action: { type: "skip" },
    }, clientIp(i), [200, 400]);
    return { ...result, status: result.body?.ok ? 200 : 400 };
  });
  console.log("R7 PASSED");
} catch (error) {
  console.error(`R7 FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
