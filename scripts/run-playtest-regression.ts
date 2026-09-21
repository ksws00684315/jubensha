import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrl } from "../src/lib/app-config";
import type { GameSummary } from "../src/lib/client";
const base = "http://127.0.0.1:3000";
const dir = ".workbuddy/audit/playtest-2026-09-21";
const role = process.argv[2] ?? "chen_man";
const run = process.argv[3] ?? "1";
const label = `${role}-${run}`;
const db = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl().url! } } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (data: object) => { const row = { at: new Date().toISOString(), ...data }; appendFileSync(`${dir}/${label}-actions.jsonl`, JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
async function req(path: string, body?: unknown, token?: string) {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { "x-seat-token": token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
  const data = await res.json();
  return { ok: res.ok, data, latencyMs: Date.now() - started };
}
async function main() {
  const title = role === "zhoubo" ? "云澜山庄的雪夜" : "第七封贺卡";
  const identityFile = `${dir}/${label}-identity.json`;
  const resume = process.argv.includes("--resume");
  let id: string;
  let token: string;
  if (resume) {
    const identity = JSON.parse(readFileSync(identityFile, "utf8")) as { gameId: string; token: string; code: string };
    id = identity.gameId;
    token = identity.token;
    log({ event: "resumed", gameId: id, code: identity.code, role });
  } else {
    const script = await db.script.findFirstOrThrow({ where: { title, deleted: false }, select: { id: true, content: true } });
    const chars = (script.content as { characters: Array<{ id: string }> }).characters;
    const order = [role, ...chars.map((c) => c.id).filter((charId) => charId !== role)];
    const room = await req("/api/rooms", { scriptId: script.id, seats: order.map((characterId, index) => ({ characterId, kind: index === 0 ? "human" : "ai" })), unlimitedHumanTurns: true });
    if (!room.ok) throw new Error(JSON.stringify(room.data));
    let joined;
    if (process.env.PLAYTEST_UI_JOIN === "1") {
      log({ event: "waiting_ui_join", code: room.data.code, label });
      let seat;
      for (let attempts = 0; attempts < 120; attempts++) {
        seat = await db.seat.findFirst({ where: { roomId: room.data.roomId, index: 0 } });
        if (seat?.token) break;
        await wait(3000);
      }
      if (!seat?.token) throw new Error("浏览器入座等待超时");
      joined = { ok: true, data: { token: seat.token } };
    } else joined = await req("/api/rooms/join", { code: room.data.code, name: `回归-${label}`, hostToken: room.data.hostToken });
    if (!joined.ok) throw new Error(JSON.stringify(joined.data));
    const started = await req(`/api/rooms/${room.data.code}/start`, { hostToken: room.data.hostToken });
    if (!started.ok) throw new Error(JSON.stringify(started.data));
    id = started.data.gameId as string;
    token = joined.data.token as string;
    writeFileSync(identityFile, JSON.stringify({ gameId: id, code: room.data.code, roomId: room.data.roomId, seatIndex: 0, token }), { mode: 0o600 });
    log({ event: "started", gameId: id, code: room.data.code, role });
  }
  const flags = new Set<string>();
  let lastStage = "";
  let lastChange = Date.now();
  const act = async (action: Record<string, unknown>, key?: string) => {
    const result = await req(`/api/games/${id}/actions`, { seatIndex: 0, token, action });
    log({ action, result: result.data, latencyMs: result.latencyMs });
    if (key && result.ok) flags.add(key);
    return result.ok;
  };
  const phrase = role === "zhoubo" ? "我看到的只是模糊人影，不能据此确认身份。请用公开物证交叉核对，别把我的推测当成事实。" : role === "zhao_kai" ? "我签酒水单是替全桌安排，单据不能证明我知道药物风险，更不能证明我持续催促某个人。" : "我亲耳听见过“药不差这一会儿”。这是我自己的陈述，需要与独立材料交叉核对；我也希望那封迟来的贺卡被认真读完。";
  while (true) {
    const fetched = await req(`/api/games/${id}?seat=0`, undefined, token);
    if (!fetched.ok) throw new Error(JSON.stringify(fetched.data));
    const s = fetched.data as GameSummary;
    const stage = `${s.phase}:${s.round}:${s.turnSeat}:${s.pendingAnswer?.toSeat}:${s.pendingInteraction?.id}`;
    if (stage !== lastStage) { log({ event: "stage", stage, publicEvidence: s.publicEvidence }); lastStage = stage; lastChange = Date.now(); }
    writeFileSync(`${dir}/${label}-summary.json`, JSON.stringify(s, null, 2));
    if (s.phase === "ENDED") break;
    if (Date.now() - lastChange > 600000) throw new Error(`阶段超过10分钟无变化：${stage}`);
    if (s.pendingInteraction) await act({ type: "interaction", beatId: s.pendingInteraction.id, choiceId: role === "chen_man" ? "speak" : s.pendingInteraction.choices[0].id });
    else if (s.phase === "READING" && !flags.has("ready")) await act({ type: "ready" }, "ready");
    else if (s.phase === "SELF_INTRO" && s.turnSeat === 0 && !flags.has("intro")) await act({ type: "speak", text: role === "zhoubo" ? "我是周伯，山庄的老管家。今晚忙着照应各处，我会只说自己确实看见的事。" : role === "zhao_kai" ? "我是赵凯，这次聚会由我张罗。我会配合把当晚安排说清楚。" : "我是陈曼，是大家的老同学。今晚我希望国栋把一直没说完的话说清楚。" }, "intro");
    else if (s.phase === "SEARCH") {
      if (!flags.has(`search:${s.round}`) && s.availableLocations.length) await act({ type: "choose_location", location: s.availableLocations.find((loc) => /服务|传菜|书房/.test(loc)) ?? s.availableLocations[0] }, `search:${s.round}`);
      for (const clue of s.myCluesV2 ?? []) {
        if (clue.policy !== "manual_public" || s.publicEvidence?.some((c) => c.id === clue.id) || flags.has(`publish:${clue.id}`)) continue;
        await act({ type: "publish", clueId: clue.id, publish: s.round !== 1 }, `publish:${clue.id}`);
      }
    } else if (s.phase === "DISCUSSION") {
      for (const to of s.openWhispers ?? []) if (!flags.has(`whisper:${s.round}:${to}`)) await act({ type: "private_chat", toSeat: to, text: "我愿意核对你亲眼见到的事实。请说明哪些是证据、哪些是猜测；未经确认的私事先留在这里。" }, `whisper:${s.round}:${to}`);
      if (s.pendingAnswer?.toSeat === 0) await act({ type: "speak", text: phrase });
      else if (!s.pendingAnswer && s.turnSeat === 0) {
        const target = s.seats.find((seat) => seat.characterName === (role === "zhoubo" ? "苏晚" : role === "zhao_kai" ? "林素芬" : "赵凯"))?.index ?? 1;
        const evidenceIds = (s.publicEvidence ?? []).slice(-2).map((c) => c.id);
        const question = s.round === 1 ? "公开材料还不能独立证明行为人。请说明你当时亲自做了什么，哪些细节有独立来源支持？" : "新增材料已经公开，你此前说法中哪些事实愿意修正，哪些部分仍需要独立证明？";
        if (!flags.has(`ask:${s.round}`)) { await act({ type: "ask", toSeat: target, text: question, evidenceIds }, `ask:${s.round}`); flags.add(`ask:${s.round}`); }
        else if (!flags.has(`duplicate:${s.round}`)) { await act({ type: "ask", toSeat: target, text: question, evidenceIds }); flags.add(`duplicate:${s.round}`); }
        else if (!flags.has(`speak:${s.round}`)) await act({ type: "speak", text: phrase }, `speak:${s.round}`);
        else await act({ type: "skip" }, `skip:${s.round}`);
      }
    } else if (s.phase === "VOTE" && !flags.has("voted")) {
      const target = s.seats.find((seat) => seat.characterName === (role === "zhoubo" ? "苏晚" : role === "zhao_kai" ? "林素芬" : "赵凯"))?.index ?? 1;
      if (!flags.has("invalid-vote")) { await act({ type: "vote", target, evidenceIds: ["nonexistent"] }); flags.add("invalid-vote"); }
      await act({ type: "vote", target, evidenceIds: (s.publicEvidence ?? []).slice(-3).map((c) => c.id), reason: "依据公开材料与陈述交叉核对后的判断，单一材料不能独立证明全部行为。" }, "voted");
    }
    // 人类行动仅经正式 HTTP；数据库读取只用于事后审计，不改状态。
    await wait(3000);
  }
  const [game, events, usage] = await Promise.all([db.game.findUnique({ where: { id } }), db.gameEvent.findMany({ where: { gameId: id }, orderBy: { seq: "asc" } }), db.usageLog.findMany({ where: { gameId: id }, orderBy: { createdAt: "asc" } })]);
  writeFileSync(`${dir}/${label}-result.json`, JSON.stringify({ game, events, usage }, (_, value) => typeof value === "bigint" ? String(value) : value, 2), { mode: 0o600 });
  log({ event: "ended", gameId: id, calls: usage.length, inputTokens: usage.reduce((sum, u) => sum + u.promptTokens, 0), failed: usage.filter((u) => !u.ok).length });
}
main().catch((error) => { log({ event: "blocked", error: String(error) }); process.exitCode = 1; }).finally(() => db.$disconnect());
