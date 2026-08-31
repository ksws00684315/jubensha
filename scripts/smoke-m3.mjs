/* M3 真人混合流程冒烟测试：1 真人 + 4 AI，走完全场 */
import { writeSync } from "node:fs";
const log = (...a) => writeSync(1, a.map(String).join(" ") + "\n");

const BASE = "http://127.0.0.1:3000";
const withRetry = async (fn, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
};
const post = (p, b) =>
  withRetry(() =>
    fetch(BASE + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(120_000),
    }).then((r) => r.json())
  );
const get = (p) => withRetry(() => fetch(BASE + p).then((r) => r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE_ORDER = ["LOBBY", "READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"];

function phaseReached(g, phase, round) {
  const gi = PHASE_ORDER.indexOf(g.phase);
  const ti = PHASE_ORDER.indexOf(phase);
  if (gi < 0 || ti < 0) return false;
  if (gi > ti) return true;
  if (g.phase !== phase) return false;
  if (round === undefined) return true;
  return g.round >= round;
}

async function waitPhase(id, phase, round, timeout = 420000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeout) {
    const g = await get(`/api/games/${id}`);
    if (g.error) throw new Error(`wait ${phase}: ${g.error}`);
    const tag = `${g.phase} r${g.round}`;
    if (tag !== last) {
      log(`  .. ${tag} (waiting ${phase}${round != null ? " r" + round : ""})`);
      last = tag;
    }
    if (phaseReached(g, phase, round)) return g;
    await sleep(800);
  }
  throw new Error(`timeout waiting phase=${phase} round=${round} last=${last}`);
}

(async () => {
  const scripts = await get("/api/scripts");
  const sample = scripts.find((s) => s.title === "云澜山庄的雪夜") || scripts.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5);
  if (!sample) throw new Error("没有可用的 5 人剧本");
  const scriptId = sample.id;
  log("script", sample.title, scriptId);
  const room = await post("/api/rooms", { scriptId, seats: [{ kind: "human" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }, { kind: "ai" }] });
  log("room", room.code);
  if (!room.hostToken) throw new Error("create room missing hostToken: " + JSON.stringify(room));
  const join = await post("/api/rooms/join", { code: room.code, name: "测试真人" });
  if (!join.token) throw new Error("join failed: " + JSON.stringify(join));
  const start = await post(`/api/rooms/${room.code}/start`, { hostToken: room.hostToken });
  const gid = start.gameId;
  const auth = { seatIndex: join.seatIndex, token: join.token };
  const act = async (action) => {
    const r = await post(`/api/games/${gid}/actions`, { ...auth, action });
    if (!r.ok && !/已经选过/.test(r.error || "")) log("  !! action failed:", JSON.stringify(action), r.error);
    return r;
  };
  const pickLocation = async (location) => {
    const r = await act({ type: "choose_location", location });
    if (!r.ok && /已经选过/.test(r.error || "")) return { ok: true, skipped: true };
    return r;
  };
  log("game", gid);

  await waitPhase(gid, "READING");
  log("ready:", JSON.stringify(await act({ type: "ready" })));
  await act({ type: "rush" });

  await waitPhase(gid, "SELF_INTRO", 1);
  log("speak:", JSON.stringify(await act({ type: "speak", text: "各位好，我是沈青禾，叔叔的侄女。晚宴后我回房休息了，听到喊声才赶来。" })));
  await act({ type: "rush" });

  await waitPhase(gid, "SEARCH", 1);
  log("location:", JSON.stringify(await pickLocation("书房")));
  // 等待获得新线索（数量从 0 增加）后做公开/私藏决定
  const publishWhenNewClues = async (prevCount) => {
    for (let i = 0; i < 25; i++) {
      const g = await get(`/api/games/${gid}?seat=${join.seatIndex}&token=${join.token}`);
      if (g.myClues.length > prevCount) {
        const fresh = g.myClues.slice(prevCount);
        for (const clueId of fresh) await act({ type: "publish", clueId, publish: false });
        return g.myClues.length;
      }
      await sleep(800);
    }
    return prevCount;
  };
  const clueCount = await publishWhenNewClues(0);

  await waitPhase(gid, "DISCUSSION", 1);
  log("private:", JSON.stringify(await act({ type: "private_chat", toSeat: 1, text: "周伯，21:15 是你送的茶吗？茶有没有被动过？" })));
  log("discuss:", JSON.stringify(await act({ type: "speak", text: "我发现书房的钥匙挂板上少了一把备用钥匙，谁能解释？" })));
  await act({ type: "rush" });

  await waitPhase(gid, "SEARCH", 2);
  log("location2:", JSON.stringify(await pickLocation("门廊雪地")));
  await publishWhenNewClues(clueCount);

  await waitPhase(gid, "DISCUSSION", 2);
  log("discuss2:", JSON.stringify(await act({ type: "speak", text: "雪地上有 37 码的女靴脚印，山庄里穿 37 码的有两位。21:15 到 21:25 之间谁去过书房？" })));
  await act({ type: "rush" });

  await waitPhase(gid, "VOTE", 1);
  log("vote:", JSON.stringify(await act({ type: "vote", target: 3, reason: "苏医生的脚印和药瓶最可疑" })));

  const final = await waitPhase(gid, "ENDED", undefined, 300000);
  log("ENDED ✓ voteResult:", JSON.stringify(final.voteResult));
  log("M3 SMOKE TEST PASSED");
})().catch((e) => {
  writeSync(2, "FAILED: " + e.message + "\n");
  process.exit(1);
});
