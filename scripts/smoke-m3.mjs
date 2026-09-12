/* M3 真人混合流程冒烟测试：1 真人 + AI 补位，走完全场 */
import { writeSync } from "node:fs";
const log = (...a) => writeSync(1, a.map(String).join(" ") + "\n");

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";
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
const get = (p) => withRetry(() => fetch(BASE + p, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE_ORDER = ["LOBBY", "READING", "SELF_INTRO", "SEARCH", "DISCUSSION", "VOTE", "REVEAL", "ENDED"];
const phaseIdx = (phase) => PHASE_ORDER.indexOf(phase);

(async () => {
  const scripts = await get("/api/scripts");
  const wantTitle = process.env.SMOKE_SCRIPT ?? "云澜山庄的雪夜";
  const sample = scripts.find((s) => s.title === wantTitle) || scripts.find((s) => s.minPlayers <= 5 && s.maxPlayers >= 5);
  if (!sample) throw new Error(`没有可用的剧本（想要：${wantTitle}）`);
  const scriptId = sample.id;
  log("script", sample.title, scriptId);
  const seatCount = Math.max(3, sample.minPlayers ?? 5);
  const seats = Array.from({ length: seatCount }, (_, i) => ({ kind: i === 0 ? "human" : "ai" }));
  const room = await post("/api/rooms", { scriptId, seats });
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
  const myStatus = () => get(`/api/games/${gid}?seat=${join.seatIndex}&token=${join.token}`);

  /** 等到谓词成立。SEARCH/DISCUSSION 交替出现，阶段序号不代表先后，谓词必须写清楚等什么。
   *  等待期间若被当众点名提问则先作答——真人不作答会停摆整局。 */
  const waitUntil = async (label, pred, timeout = 420000) => {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < timeout) {
      // 必须带座位凭证:未鉴权概要的 pendingAnswer 恒为 null,"被点名自动作答"守卫会失效
      const g = await myStatus();
      if (g.error) throw new Error(`wait ${label}: ${g.error}`);
      const tag = `${g.phase} r${g.round}`;
      if (tag !== last) {
        log(`  .. ${tag} (waiting ${label})`);
        last = tag;
      }
      if (g.pendingAnswer && g.pendingAnswer.toSeat === join.seatIndex) {
        log("  .. 被点名提问，当众作答");
        await act({ type: "speak", text: "这个问题我记下了：稍后结合大家的时间线一起回应，先把我知道的情况摆出来。" });
        await sleep(600);
        continue;
      }
      if (pred(g, Date.now() - t0)) return g;
      await sleep(800);
    }
    throw new Error(`timeout waiting ${label} last=${last}`);
  };

  /** 轮到我发言时说一句并结束发言；等待期间若被当众点名提问则先作答（否则流程停摆）。 */
  const speakMyTurn = async (text, phases) => {
    const okPhases = phases ?? ["DISCUSSION"];
    for (let i = 0; i < 400; i++) {
      const g = await myStatus();
      if (g.pendingAnswer && g.pendingAnswer.toSeat === join.seatIndex) {
        log("  .. 被点名提问，先当众作答");
        await act({ type: "speak", text: "这个问题我记下了，容我对照时间线再详细回应，先把已知的情况说清楚。" });
        await sleep(600);
        continue;
      }
      if (g.turnSeat === join.seatIndex) {
        log("speak:", JSON.stringify(await act({ type: "speak", text })));
        await act({ type: "skip" });
        return true;
      }
      if (!okPhases.includes(g.phase)) return false;
      await sleep(800);
    }
    return false;
  };

  const pickLocation = async (location) => {
    let r = await act({ type: "choose_location", location });
    if (!r.ok && /已经选过/.test(r.error || "")) return { ok: true, skipped: true };
    // 目标地点不存在/线索被搜完时，改为选择第一个还有线索的地点
    if (!r.ok) {
      const g = await myStatus();
      const alt = (g.availableLocations ?? [])[0];
      if (alt) r = await act({ type: "choose_location", location: alt });
    }
    return r;
  };

  // 等待获得新线索（数量从 0 增加）后做私藏决定
  const publishWhenNewClues = async (prevCount) => {
    for (let i = 0; i < 25; i++) {
      const g = await myStatus();
      if (g.myClues.length > prevCount) {
        const fresh = g.myClues.slice(prevCount);
        for (const clueId of fresh) await act({ type: "publish", clueId, publish: false });
        return g.myClues.length;
      }
      await sleep(800);
    }
    return prevCount;
  };

  log("game", gid);

  await waitUntil("READING", (g) => phaseIdx(g.phase) >= 1);
  log("ready:", JSON.stringify(await act({ type: "ready" })));
  await act({ type: "rush" });

  await waitUntil("SELF_INTRO r1", (g) => phaseIdx(g.phase) >= 2);
  await speakMyTurn("各位好，我是今晚的到场者之一。晚宴后我回房休息了，听到喊声才赶来。", ["SELF_INTRO", "DISCUSSION", "SEARCH"]);
  await act({ type: "rush" });

  await waitUntil("SEARCH r1", (g) => g.phase === "SEARCH" && g.round >= 1);
  log("location:", JSON.stringify(await pickLocation("书房")));
  const clueCount = await publishWhenNewClues(0);

  await waitUntil("DISCUSSION r1", (g) => g.phase === "DISCUSSION" && g.round >= 1);
  log("private:", JSON.stringify(await act({ type: "private_chat", toSeat: 1, text: "问一句：案发前后你都在哪里？" })));
  await speakMyTurn("我发现现场少了一件关键东西，谁能解释？");
  await act({ type: "rush" });

  // 第 2 轮搜证（若剧本流程跳过则直接等到讨论 2 / 投票）
  await waitUntil(
    "SEARCH r2 / DISCUSSION r2 / VOTE",
    (g) => (g.phase === "SEARCH" && g.round >= 2) || (g.phase === "DISCUSSION" && g.round >= 2) || phaseIdx(g.phase) >= 5
  );
  const s2 = await myStatus();
  if (s2.phase === "SEARCH") {
    log("location2:", JSON.stringify(await pickLocation("门廊雪地")));
    await publishWhenNewClues(clueCount);
  } else {
    log("  .. 本剧本第 2 轮搜证后直接进入讨论/投票，跳过 location2");
  }

  await waitUntil("DISCUSSION r2 / VOTE", (g) => (g.phase === "DISCUSSION" && g.round >= 2) || phaseIdx(g.phase) >= 5);
  await speakMyTurn("综合大家的时间线，案发窗口期里行踪存疑的人该给个说法了。");
  await act({ type: "rush" });

  await waitUntil("VOTE", (g) => phaseIdx(g.phase) >= 5);
  const me = await myStatus();
  if (me.quiz && Array.isArray(me.quiz.questions) && me.quiz.questions.length > 0) {
    // 复盘答题：每题选第一项（冒烟只验证链路，不追求答对）
    const answers = me.quiz.questions.map((q) => ({ questionId: q.id, optionId: q.options[0].id }));
    log("quiz:", JSON.stringify(await act({ type: "answer_quiz", answers })));
  }
  if (me.voteMode !== "choice") {
    log("vote:", JSON.stringify(await act({ type: "vote", target: seatCount > 4 ? 3 : 1, reason: "综合讨论与线索，此人的疑点最大" })));
  }

  const final = await waitUntil("ENDED", (g) => g.phase === "ENDED", 300000);
  log("ENDED ✓ voteResult:", JSON.stringify(final.voteResult));
  if (final.quizResult) log("ENDED ✓ quizResult perSeat:", JSON.stringify(final.quizResult.perSeat));
  log("M3 SMOKE TEST PASSED");
})().catch((e) => {
  writeSync(2, "FAILED: " + e.message + "\n");
  process.exit(1);
});
