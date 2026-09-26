/**
 * 试玩验收 e2e：A 投票证据校验 / B 搜证耗尽可观测 / C 保底公开预告闭环 / D 凶手专属结算卡。
 * 用《上元灯影·贺灯酒》（6 人，12 线索 / 4 地点，3 个单线索地点，9 张保底公开线索）确定性编排：
 *   - 第 1 轮搜证把 3 个单线索地点全部搜空 → 第 2 轮麻三娘（座位见下）必然无可搜地点（B 哨兵）；
 *   - 麻三娘第 1 轮在河埠头必得【河埠头夜航船】（保底第 2 轮公开）→ 私藏后第 2 轮被强制公开并收到定向私讯（C）；
 *   - 投票阶段先打两种非法用法再正常投票（A）；ENDED 后按 myCard.isCulprit 分流断言结算互斥（D）。
 * 需要 dev server 运行：node scripts/acceptance-playtest.mjs
 */
const BASE = process.env.ACCEPT_BASE ?? process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";
const SCRIPT_TITLE = process.env.ACCEPT_SCRIPT ?? "上元灯影·贺灯酒";

const results = [];
function check(label, cond, detail = "") {
  results.push({ label, ok: Boolean(cond), detail });
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${detail && !cond ? ` —— ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, tries = 40) {
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000);
      continue;
    }
    if (res.status === 429) {
      const waitSec = Number(res.headers.get("Retry-After")) || 3;
      await sleep(waitSec * 1000 + 250);
      continue;
    }
    return res.json();
  }
  throw new Error(`post ${path}: 限流重试 ${tries} 次仍失败`);
}
async function get(path, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(30_000) });
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000);
    }
  }
}

let gid = "";
const tokens = [];
const lastSeq = [];
const sseBuf = [];

/** 读取某座位的新事件（SSE 快照，按 lastSeq 续传），累积进 sseBuf。 */
async function pumpSse(seat, ms = 2500) {
  const url = `${BASE}/api/games/${gid}/events?seat=${seat}&token=${tokens[seat]}&lastSeq=${lastSeq[seat] ?? 0}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let buf = "";
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    for await (const chunk of res.body) buf += Buffer.from(chunk).toString("utf8");
  } catch {
    /* 超时即截断，够用 */
  }
  clearTimeout(timer);
  for (const line of buf.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const msg = JSON.parse(line.slice(6));
      if (msg.kind === "event" && msg.event?.seq !== undefined) {
        if (BigInt(msg.event.seq) > (lastSeq[seat] ?? BigInt(0))) lastSeq[seat] = BigInt(msg.event.seq);
        sseBuf[seat].push(msg.event);
      }
    } catch {
      /* 忽略坏行 */
    }
  }
}
const sseHas = (seat, fn) => sseBuf[seat].some(fn);
const seatText = (seat, text) => sseHas(seat, (e) => e.type === "system" && e.visibility === `seat:${seat}` && e.content.text === text);

async function status(seat) {
  return get(`/api/games/${gid}?seat=${seat}&token=${tokens[seat]}`);
}
async function act(seat, action) {
  await sleep(350); // 动作限流 60 次/分钟/IP：6 个座位共用一个出口，必须节流
  return post(`/api/games/${gid}/actions`, { seatIndex: seat, token: tokens[seat], action });
}

/** 等待阶段到达；等待期间处理被当众提问/互动节拍，避免流程停摆。 */
async function waitPhase(target, roundPred = () => true, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let allOk = true;
    for (let seat = 0; seat < tokens.length; seat++) {
      const g = await status(seat);
      if (g.error) throw new Error(`status(${seat}): ${g.error}`);
      if (g.phase === target && roundPred(g)) return g;
      if (g.pendingInteraction) {
        const beat = g.pendingInteraction;
        await act(seat, { type: "interaction", beatId: beat.beatId ?? beat.id, choiceId: beat.choices?.[0]?.id });
      }
      if (g.pendingAnswer && g.pendingAnswer.toSeat === seat) {
        await act(seat, { type: "speak", text: "这个问题我记下了，容我对照时间线再回应。" });
      }
      if (g.phase !== target) allOk = false;
    }
    if (allOk) return await status(0);
    await pumpSse(3, 1200);
  }
  throw new Error(`timeout waiting phase=${target}`);
}

/** 发言回合驱动：轮到谁谁说一句并结束（SELF_INTRO 发言后自动推进）。 */
async function driveSpeaking(phases, text) {
  const spoken = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000 && spoken.size < tokens.length) {
    for (let seat = 0; seat < tokens.length; seat++) {
      if (spoken.has(seat)) continue;
      const g = await status(seat);
      if (g.pendingInteraction) await act(seat, { type: "interaction", beatId: g.pendingInteraction.beatId ?? g.pendingInteraction.id, choiceId: g.pendingInteraction.choices?.[0]?.id });
      if (g.pendingAnswer && g.pendingAnswer.toSeat === seat) {
        await act(seat, { type: "speak", text: "这个问题我记下了，容我对照时间线再回应。" });
        continue;
      }
      if (phases.includes(g.phase) && g.turnSeat === seat) {
        await act(seat, { type: "speak", text });
        if (phases.includes("DISCUSSION")) await act(seat, { type: "skip" });
        spoken.add(seat);
      }
    }
    await sleep(600);
  }
  if (spoken.size < tokens.length) throw new Error(`speaking turns incomplete: ${spoken.size}/${tokens.length}`);
}

async function driveSearchPicks(round, assign) {
  for (let seat = 0; seat < tokens.length; seat++) {
    const loc = assign[seat];
    let r = await act(seat, { type: "choose_location", location: loc });
    if (!r.ok && !/已经选过|无可搜地点/.test(r.error ?? "")) {
      const g = await status(seat);
      const alt = (g.availableLocations ?? [])[0];
      if (alt) r = await act(seat, { type: "choose_location", location: alt });
    }
    if (!r.ok && !/已经选过|无可搜地点/.test(r.error ?? "")) throw new Error(`r${round} seat${seat} choose ${loc}: ${JSON.stringify(r)}`);
  }
}

/** 公开/私藏决策：全部私藏（对局推进不受影响，保底线索到期会被主持强制公开）。 */
async function drivePublish() {
  const t0 = Date.now();
  let pendingLeft = true;
  while (Date.now() - t0 < 120_000 && pendingLeft) {
    pendingLeft = false;
    for (let seat = 0; seat < tokens.length; seat++) {
      const g = await status(seat);
      for (const clueId of g.pendingPublishClueIds ?? []) {
        const r = await act(seat, { type: "publish", clueId, publish: false });
        if (!r.ok && !/已经/.test(r.error ?? "")) throw new Error(`publish seat${seat} ${clueId}: ${JSON.stringify(r)}`);
        pendingLeft = true;
      }
    }
    await sleep(700);
  }
}

(async () => {
  console.log(`acceptance-playtest @ ${BASE} · 剧本《${SCRIPT_TITLE}》`);
  const scripts = await get("/api/scripts");
  const script = scripts.find((s) => s.title === SCRIPT_TITLE);
  if (!script) throw new Error(`剧本不在库中：${SCRIPT_TITLE}`);
  const seatCount = script.maxPlayers;

  // 建房：全真人座位，逐个入座拿凭证
  const room = await post("/api/rooms", { scriptId: script.id, seats: Array.from({ length: seatCount }, () => ({ kind: "human" })) });
  if (!room.code || !room.hostToken) throw new Error("create room failed");
  for (let i = 0; i < seatCount; i++) {
    const join = await post("/api/rooms/join", { code: room.code, name: `验收${i}` });
    tokens[i] = join.token;
    lastSeq[i] = BigInt(0);
    sseBuf[i] = [];
  }
  const start = await post(`/api/rooms/${room.code}/start`, { hostToken: room.hostToken });
  gid = start.gameId;
  if (!gid) throw new Error("start failed");
  console.log(`room ${room.code} · game ${gid}`);

  // 依角色名定座位：地点归属（柜台=麻三娘/灯铺=白子安/河埠头=柳承业）决定编排
  await waitPhase("READING");
  const g0 = await status(0);
  const seatOf = (name) => g0.seats.find((s) => s.characterName === name)?.index;
  const LOC = { yage: "缀锦楼三楼雅阁", gui: "缀锦楼柜台大堂", deng: "灯市灯铺", budou: "河埠头" };
  check("P0 剧本地点名与编排假设一致", [LOC.yage, LOC.gui, LOC.deng, LOC.budou].every((l) => g0.locations.includes(l)), JSON.stringify(g0.locations));
  const seatLiu = seatOf("柳承业");
  const seatMa = seatOf("麻三娘");
  const seatBai = seatOf("白子安");
  const others = [...Array(seatCount).keys()].filter((i) => i !== seatLiu && i !== seatMa && i !== seatBai);
  const r1Assign = [];
  r1Assign[seatLiu] = LOC.deng; // 灯铺单线索（走马灯夹帕）搜空——灯铺是白子安的房间，必须由别人搜
  r1Assign[seatBai] = LOC.yage;
  r1Assign[others[0]] = LOC.yage; // 雅阁 2 张线索正好被 2 人搜空
  r1Assign[seatMa] = LOC.budou; // 河埠头单线索（河埠头夜航船，保底第 2 轮公开）——河埠头是柳承业的房间，由麻三娘搜
  r1Assign[others[1]] = LOC.gui;
  r1Assign[others[2]] = LOC.gui;

  for (let seat = 0; seat < seatCount; seat++) await act(seat, { type: "ready" });

  await waitPhase("SELF_INTRO");
  await driveSpeaking(["SELF_INTRO"], "各位好，我按本上的来：我是到场者之一，行踪稍后细说。");

  // 第 1 轮搜证 + 全部私藏
  await waitPhase("SEARCH", (g) => g.round >= 1);
  await driveSearchPicks(1, r1Assign);
  await drivePublish();
  await waitPhase("DISCUSSION", (g) => g.round >= 1);
  await driveSpeaking(["DISCUSSION"], "我先听大家的，稍后补充我的时间线。");

  // ── C 预告：麻三娘第 1 轮在河埠头搜到【河埠头夜航船】，提示语必须预告"最迟第 2 轮" ──
  await pumpSse(seatMa, 2500);
  const maR1Notice = sseBuf[seatMa].find((e) => e.type === "system" && (e.content.text ?? "").includes("河埠头夜航船"));
  check("C1 保底线索搜到时预告公开轮次（含「最迟第 2 轮」）", maR1Notice && /最迟第 2 轮结束将由主持公开/.test(maR1Notice.content.text ?? ""), JSON.stringify(maR1Notice?.content?.text ?? null));

  // 第 2 轮搜证：麻三娘必然无可搜地点（雅阁/灯铺/河埠头已搜空、柜台是自己的房间）
  await waitPhase("SEARCH", (g) => g.round >= 2);
  let sentinelSeen = false;
  for (let i = 0; i < 12 && !sentinelSeen; i++) {
    await pumpSse(seatMa, 1500);
    sentinelSeen = seatText(seatMa, "本轮没有可搜的线索材料，系统已自动完成搜证，将进入下一环节。");
  }
  check(
    "B1 无可搜座位收到定向自动完成说明",
    sentinelSeen,
    "未在麻三娘的私讯流中找到该文案",
  );
  const exhaustedSeat = await status(seatMa);
  check("B2 无可搜座位 searchExhausted=true 且 availableLocations 为空", exhaustedSeat.searchExhausted === true && (exhaustedSeat.availableLocations ?? []).length === 0, JSON.stringify({ searchExhausted: exhaustedSeat.searchExhausted, avail: exhaustedSeat.availableLocations }));
  const sentinelReject = await act(seatMa, { type: "choose_location", location: exhaustOrFirst(exhaustedSeat) });
  check("B3 哨兵座位选点报错为区分文案（非「本轮已经选过地点」）", sentinelReject.ok === false && sentinelReject.error === "本轮已无可搜地点，系统已自动完成搜证，无需选择", JSON.stringify(sentinelReject));
  const r2Assign = [];
  for (let seat = 0; seat < seatCount; seat++) if (seat !== seatMa) r2Assign[seat] = LOC.gui;
  await driveSearchPicks(2, r2Assign);
  await drivePublish();
  await waitPhase("DISCUSSION", (g) => g.round >= 2);
  await driveSpeaking(["DISCUSSION"], "两轮材料都摊开了，我坚持我前面的说法。");

  // ── A 投票证据校验 ──
  await waitPhase("VOTE");
  const voter = 0;
  const noEvidence = await act(voter, { type: "vote", target: 1, reason: "验收：不附证据" });
  check("A1 有公开证据却不附 evidenceIds：报错指明字段", noEvidence.ok === false && (noEvidence.error ?? "").includes("evidenceIds"), JSON.stringify(noEvidence));
  const badEvidence = await act(voter, { type: "vote", target: 1, reason: "验收：非法证据", evidenceIds: ["ghost_card_x"] });
  check("A2 全非法证据 id：报错逐个列出", badEvidence.ok === false && badEvidence.error === "证据含非法或未公开的线索卡：ghost_card_x", JSON.stringify(badEvidence));

  for (let seat = 0; seat < seatCount; seat++) {
    const g = await status(seat);
    const evidenceIds = (g.publicEvidence ?? []).slice(0, 3).map((c) => c.id);
    const r = await act(seat, { type: "vote", target: seat === 0 ? 1 : 0, reason: "验收投票", ...(evidenceIds.length ? { evidenceIds } : {}) });
    if (!r.ok && !/已经投过/.test(r.error ?? "")) throw new Error(`vote seat${seat}: ${JSON.stringify(r)}`);
  }

  await waitPhase("ENDED", () => true, 240_000);

  // ── C 强制公开私讯：麻三娘私藏的【河埠头夜航船】被主持补发时必须收到定向私讯 ──
  await pumpSse(seatMa, 2500);
  check(
    "C2 私藏的保底线索被强制公开时，原发现人收到定向私讯",
    seatText(seatMa, "你私藏的【河埠头夜航船】已到保底公开时限，主持人已当众公开。"),
    "未在麻三娘的私讯流中找到强制公开私讯",
  );

  // ── D 结算互斥：凶手座拿 culpritSettlement，其余拿 settlement ──
  const finals = [];
  for (let seat = 0; seat < seatCount; seat++) finals.push(await status(seat));
  const culpritSeat = finals.findIndex((g) => g.seats[g.mySeat]?.myCard?.isCulprit === true);
  check("D0 能唯一定位凶手座位", culpritSeat >= 0);
  if (culpritSeat >= 0) {
    const cul = finals[culpritSeat];
    check("D1 凶手座 settlement=null 且 culpritSettlement 非空", cul.settlement === null && cul.culpritSettlement !== null, JSON.stringify({ settlement: cul.settlement, culpritSettlement: cul.culpritSettlement }));
    check("D2 凶手卡 outcome 与票数正确", !!cul.culpritSettlement && cul.culpritSettlement.outcome === (cul.voteResult?.caught ? "exposed" : "escaped") && cul.culpritSettlement.votesAgainst === (cul.voteResult?.counts?.[String(culpritSeat)] ?? 0) && typeof cul.culpritSettlement.title === "string" && cul.culpritSettlement.title.length > 0, JSON.stringify(cul.culpritSettlement));
    for (let seat = 0; seat < seatCount; seat++) {
      if (seat === culpritSeat) continue;
      const g = finals[seat];
      if (g.settlement === null || g.culpritSettlement !== null) {
        check(`D3 非凶手座(${seat}) settlement 非空且 culpritSettlement=null`, false, JSON.stringify({ settlement: g.settlement, culpritSettlement: g.culpritSettlement }));
      }
    }
    check("D3 非凶手座结算卡字段齐全", finals.filter((_, i) => i !== culpritSeat).every((g) => g.settlement !== null && g.culpritSettlement === null && typeof g.settlement.score === "number" && typeof g.settlement.voteCorrect === "boolean"));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? "ACCEPTANCE FAILED" : "ACCEPTANCE PASSED"}：${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) process.exit(1);
})().catch((e) => {
  console.error("ACCEPTANCE ERROR:", e?.message ?? e);
  process.exit(1);
});

function exhaustOrFirst(g) {
  return (g.availableLocations ?? [])[0] ?? "缀锦楼柜台大堂";
}
