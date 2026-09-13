# 显式债务整改计划 · 回合执行器与终局事务

> 交付对象:负责开发的执行代理。本计划自包含。
> 项目:`/Users/hh-mini/Public/dev/jubensha`(Next.js 16 + React 19 + TS + Prisma/PostgreSQL + Vitest,pm2 跑 `next start`)。
> 日期基准:2026-09-13,HEAD 时 `engine.ts` 约 1830 行、174 个测试全绿。
> 上游依据:`docs/script-review-2026-09-round2.md` 登记的显式债务(M6 锁重构 / 终局事务化 / 事件溯源重放协议)与两轮独立审查结论。

---

## 0. 当前架构事实(先读代码核对,再动手)

引擎是**单实例内存状态机 + DB 快照 + append-only 事件流**:

- `GameEngine.exclusive(fn)`(engine.ts):Promise 链互斥队列,**所有**外部入口(HTTP 动作、DM 动作、tick)都排队执行;`busy` 标志防重入,`continueTick()` 用 setImmediate 触发续跑。
- **问题所在**:`tickInner()` 的正式回合里,`aiSpeak`/`dmSay`(经 `consumeStream`)同步等待 LLM 流式输出(最长 90s,DM 180s)。期间真人玩家的全部 HTTP 动作(发言/搜证/投票/交易/技能)排队阻塞;连续 4 个 AI 回合可阻塞数分钟。
- **已有的锁外模式**(可参照,勿另起炉灶):`queueAiVote`/`queueAiSearchChoice`/`queueAiWhisper`/`queueAiQuiz`/`maybeQueueInterjection` 等——`scheduleBackground(key, fn, delay)` 在锁外跑 LLM,完成后 `exclusive()` 内**重校验状态再提交**。
- 终局:`transitionReveal`(只算结果+置 REVEAL+persist)→ `finishReveal`(幂等:reveal 事件→ENDED 事件→persist→`finalizeEnded`)→ `finalizeEnded`(`endFinalized` 防重;`revealRetries` 限 3 次重试)。**残余问题**:`game.update`+`room.update` 两条写非原子;事件写入与状态持久化亦非原子。
- 事件溯源:恢复以 `games.state` 快照为权威;`rebuildStateFromEvents` 已删除(不覆盖技能/答题/限时等新状态,且无调用者)。文件头与 Prisma 注释仍残留"可由事件重放重建"的过时表述。
- 数据债务:39 条"证据链薄弱"warning 为结构性限制(对应书籍缺可交叉的线索类型),前轮按宁缺勿滥未硬塞。

**硬性不变式(同 engine-gameplay-batch-plan.md,违反即返工)**:
1. 信息防火墙:AI prompt 只经 `context.ts`;新代码不得新增取数路径。
2. 前缀缓存:同一座位 system 整局不变;动态内容在 user 尾部。
3. 旧档兼容:`GameState` 新字段在 `load()` 里 `??=`;Schema 新字段全部带默认值;34 本 validator 0 error。
4. SSE 三处一致:事件类型的 `renderEventLog`(LLM 视角)、events 路由 `visibleTo`、前端 `EventBubble` 必须同步。
5. 验收命令:`npx vitest run && npx tsc --noEmit && npx eslint src --quiet` 全绿 + 34 本 validator 0 error;最后 `npm run build && pm2 restart jubensha && node scripts/smoke-m3.mjs`(冒烟打 :3000,测试对局要清理)。

---

## 里程碑 M1:回合执行器(Turn Executor)——AI 回合移出互斥锁 【工作量 L】

### 目标
真人玩家的 HTTP 动作在 AI 思考/发言期间不再排队;AI 发言的流式 delta 照常实时推送;任一环节失败都能把回合推进下去(不允许回合悬空)。

### 设计

**核心思想**:把"执行一个 AI 回合"从 tick 的同步调用改为**三段式异步任务**:

```
tickInner(锁内,毫秒级)
  └─ 判定"座位 N 应说话,参数 opts" → dispatchTurn(task) 记录在案后立即返回
后台(锁外,秒~分钟)
  └─ LLM 流式生成,delta 实时 publish(与现状一致),句子级守卫照常
提交(exclusive 内,毫秒级)
  └─ 校验 turnTicket 仍有效 → recordEvent + 状态推进(markSpoken/nextTurn/…)
       → 清 turnInFlight → continueTick()
```

**新增状态与守卫**:
- `private turnInFlight = false;` — 引擎同一时刻至多一个"正式回合"在飞。
- `private turnTicket: { kind: "speak" | "dm"; seat: number | null; phase: Phase; round: number; token: number } | null` — 提交校验用。
- `private turnSeq = 0;` — 每次 dispatchTurn 自增,作为 ticket token;提交时 token 不匹配即丢弃(过期回合)。
- `continueTick()` 与 `handleAction` 入口:若 `turnInFlight` 为真,**直接返回**(不排队)——真人动作无需等待,回合结束后由提交阶段触发 `continueTick()` 续跑。
- 看门狗:`dispatchTurn` 同时 `schedule("turn-watchdog", abort+skip, TURNTIMEOUT × 2)`;正常完成时清掉。流式本身有 180s AbortSignal 兜底,看门狗防的是"提交队列被意外占死"。

**需要改造的调用点**(全部在 engine.ts):
| 现调用 | 改造后 |
|---|---|
| `SELF_INTRO/DISCUSSION` 的 `await this.aiSpeak(seat, opts)` + `markSpoken` + `nextTurnOrAdvance` | `dispatchPlayerTurn(seat, opts, { after: "markSpokenAdvance" })` |
| `resolvePendingAnswer` 的 `await this.aiSpeak(target, { hint })`(forced 质询) | `dispatchPlayerTurn(target, opts, { after: "clearPendingAnswer" })`——提交时清 `pendingAnswer` 并 `continueTick` |
| 各转场的 `await this.dmSay(task, phase, round)` | `dispatchDmTurn(task, phase, round, { after: <该转场的下一步> })`——转场的后续(step 推进)由提交阶段执行 |

**提交阶段必须重校验**(条件不满足就丢弃并记日志,宁可跳过不可错序):
- `state.phase`/`state.round` 与 ticket 一致(转场后旧回合的迟到发言直接丢弃);
- `state.turnSeat === seat`(玩家回合);
- 未有新的 `pendingAnswer` 抢占。

**流式失败的降级链保持不变**(锁外完成):流式失败→非流式 `playerSpeak`/`dmNarrate`(带重试+fallback)→固定提示语;全失败→提交"跳过回合"(markSpoken + nextTurn)并在事件流里 systemSay,回合绝不悬空。

**超时矩阵**(保持现有值):玩家发言 90s、DM 旁白 180s、看门狗 2×;`AbortSignal` 已在 chatStream 内。

**明确不改**:锁外已有后台任务(queueAiVote/Whisper/Interject/Quiz/Suggest/Embed/Memory)维持原模式;`finishReveal/finalizeEnded` 的幂等语义保持;人类玩家的超时路径(`ensureHumanTimeout`)不变。

### 测试(扩展 `src/core/engine/engine.longflow.test.ts` 的 mock 夹具)
1. **并发回归(本里程碑的核心断言)**:AI 思考期间(mock chatStream 挂起 5s 不返回),真人 `handleAction` 的耗时应 < 100ms(用 Date.now 差值断言),且动作正常生效。
2. 全流程回归:现有 3 个长流程测试不改语义仍全绿(允许把"等待 AI 回合完成"的辅助函数改为轮询 `turnInFlight === false`)。
3. 过期回合:人为在后台任务挂起时推进 phase,提交阶段应丢弃迟到发言(断言事件流无该 speech)。
4. 看门狗:mock chatStream 永不返回 → 看门狗触发 → 回合被跳过、流程继续到 ENDED。
5. 失败链:mock chatStream 抛错 + chat 抛错 → systemSay 错误提示 + markSpoken + 流程继续。

### 风险与对策
- **重入网**:tick 在 dispatch 后立即返回,若 `pendingTick` 逻辑处理不当会造成 tick 风暴——`turnInFlight` 必须同时挡住 `step()` 对同一座位的重复 dispatch(比如 DISCUSSION 分支在 turnInFlight 时直接 return)。
- **DM 转场链**:转场(如 transitionSearch)的 dmSay 是链式第一步,后续 step 依赖它完成——dmSay 也异步化后,step 的"后续"必须挂在提交回调里,否则会在旁白未出时推进阶段。实现时用 `after` 回调统一处理,禁止在 dispatch 后同步继续写状态。
- 冒烟脚本与前端 SSE 已按 delta/事件模型工作,不需要改。

---

## 里程碑 M2:终局事务化 + 快照权威声明 【工作量 S】

1. `finalizeEnded` 的两条写(`db.game.update` + `db.room.update`)合并为 `db.$transaction([prisma.game.update..., prisma.room.update...])`(Prisma 交互式事务或数组式均可);失败仍走既有重试(`endFinalized` 不置位,下一次 tick/动作重入)。
2. `finishReveal` 的"ENDED 事件 + persistState"次序调整为:**先 persistState(含 ENDED 状态)再 recordEvent(ENDED 事件)**——保证"状态已终局"时事件流必然随后可补(事件写入失败由 REVEAL/ENDED 重试分支兜底)。
3. 声明快照权威:修正 `prisma/schema.prisma` 的 Game 注释与 `docs/` 中"可由事件重放重建"的过时表述为"恢复以 games.state 快照为权威,事件流用于回放展示与审计";确认 `load()` 的兼容兜底注释一致。
4. 测试:mock db 的 `game.update` 首次抛错 → 断言重试后 room.update 仍被调用且 ENDED 事件恰好一条;`$transaction` 断言两条写同批提交(可用调用序断言)。

---

## 里程碑 M3:39 条结构性证据链内容批 【工作量 M,可与 M1 并行(只动 seeds)】

**约束先行**:R1 校验器规定线索数 ≤ 角色数×搜证轮数,且云澜(10/10)、火锅局(8/8)、极夜(12/12)已 **==cap**——所以补线索的方案只能"**替换**":把同书一条低价值线索(未入任何链/红鲱鱼、category 与案情无关)改写为缺失类型的交叉线索,或把线索挪到别的地点;绝不净增线索数。搜证轮数不改。

**逐本决策流程**(对 39 条 warning 所在的书):
1. 跑 validator 拿到精确清单;
2. 对每条 warning 链:读 reveal/method,判断缺的是人证(document/testimony)还是物证(object/trace/medical/digital);
3. 三选一:
   a. **改写**:把一条游离线索的 category/name/content 改写为缺失类型且语义支撑该链结论的证据(内容必须与 reveal 既有事实一致,禁止新事实);
   b. **换位**:把 A 地点的可用线索移到 B 地点(locationId 改动)以服务"核心证据分散 ≥2 地点";
   c. **接受**:该书线索池确实无法支撑交叉 → 保持 warning,登记"结构性不可达"。
4. 每本完成即跑 validator;最终全量复验并输出"修复 N 条 / 接受 M 条"清单。

**验收**:34 本 0 error;单线索链 0;交叉类 warning 只剩"接受"清单内的条目;`git diff` 逐字段审计仅动 clues/timeline 允许字段;`sync-seed-scripts --write` 同步数据库。

---

## 里程碑 M4:回归验收与发布

1. 全量门禁(vitest/tsc/eslint/validator);
2. `npm run build && pm2 restart jubensha`;
3. 冒烟 `node scripts/smoke-m3.mjs` PASSED,测试对局清理;
4. 人工冒烟(可选但建议):开一局人机混合,验证 AI 思考期间真人可正常发言/搜证/使用技能;
5. 更新 README 已知限制(删去"AI 回合期间操作会排队"类表述,若有)、本计划勾选执行状态、round2 文档追加处置记录。

---

## 非目标(明确不做,防止范围蔓延)

- 多实例/横向扩展(单实例是产品前提);
- 用事件流完全替代快照(快照权威已定,只补文档与事务);
- 存量书第二秘密(生成器规范已覆盖新书);
- 47 条合法短句时间线(非缺陷);
- TTS 协议扩展、私聊 AI-AI(产品层未要求)。

## 验收基线(当前,供对比)

| 项 | 值 |
|---|---|
| vitest | 174 passed(含 3 项长流程) |
| tsc/eslint | 0 错/0 输出 |
| 34 本 validator | 0 error / 39 条结构性链 warning |
| 冒烟 | PASSED(1 真人+4 AI,全流程) |
| 缓存命中率 | 整体 36.1%(短局),culprit 49% |


---

## 执行状态(2026-09-13)

| 里程碑 | 状态 | 结果 |
|---|---|---|
| M2 终局事务化+快照权威 | ✅ | finalizeEnded 两条写合并 $transaction;ENDED 先落快照再补事件;Prisma 注释声明快照权威 |
| M1 回合执行器 | ✅ | dispatchTurn/dispatchPlayerSpeech/dispatchAnswerTurn/dispatchDmTurn;七个调用点全部改造;看门狗+降级链;新增并发回归测试(AI 挂起时真人动作立即可用+看门狗强制推进) |
| M3 证据链内容批 | ✅ | 修复 15 条(14 链补交叉 + 1 线索改写 + 1 分类纠正)/接受 24 条(逐条登记结构性理由);13 本、仅动允许字段、线索数零净增 |
| M4 回归验收 | ✅ | 175 测试全绿、tsc/eslint 干净、34 本 0 error(24 条"接受"级 warning 为登记残量)、同步 DB、build/restart、冒烟 PASSED(culprit 被指认,caught=true) |

**剩余登记(非本轮范围,均有依据)**:
- 24 条"缺人证/物证交叉"warning:对应书籍线索池缺可交叉类型,属内容创作型长尾,已在 validator 中持续可见;
- 47 条合法短句时间线:非缺陷(逐条抽验为完整短句节拍);
- 第二秘密:生成器规范已覆盖新书,存量书维持不改(矛盾风险)。
