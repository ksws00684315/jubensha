# 引擎玩法批 · 详细执行计划

> 交付对象:负责开发的执行代理。本计划自包含——不需要此前任何对话上下文。
> 项目根目录:`/Users/hh-mini/Public/dev/jubensha`(Next.js 16 + React 19 + TS + Prisma/PostgreSQL + Vitest,pm2 管理进程)。
> 决策来源:`docs/script-review-2026-09-round2.md` 第三节 P1 清单与第五节项⑤决策("结构化结局/技能卡/线索交易按需排期"),本计划即其排期落地。

## 执行状态(2026-09-12)

- [x] **M1 线索交易** — commit `5e66000`
- [x] **M2 技能卡与行动点(质询)** — commit `67a628a`
- [x] **M3 结构化结局与多选项投票** — commit `99a1248`
- [x] 3.5 加分项:演示种子 `seeds/generated/sample-4p-quiz.json`(深夜食堂 choice 版,3 道还原题)已入库;`smoke-m3.mjs` 支持 `SMOKE_SCRIPT` 选本
- 验收:vitest 132 全过 / tsc 0 错误 / eslint 0 输出 / 34 本种子 validator 0 error / schema 已重生成

与计划的偏差(均按"最小侵入 + 向后兼容"处理):

1. `finaleMissing` 增加 `hasQuiz` 参数——hybrid/choice 且无题目的剧本(未过校验的导入)不会卡死终局。
2. 概要 API 的 `quiz.questions` 对所有视角可见(题面本就是全场公开的答题卡,不含正确项);`myAnswers` 仍仅本人可见。
3. 基线清理:开工时仓库存在一批未提交的完整功能批次(流式/分层记忆/插话私信等),已先单独提交为 `8cdd51c`,不与里程碑混合。
4. M2/M3 后 `scripts/[id]/route.ts` 的损坏剧本兜底字面量同步补新字段默认值(tsc 强制)。

---

## 0. 必读约束(违反任意一条即返工)

这些是本仓库的硬性架构不变式,来自之前多轮开发的沉淀:

1. **信息防火墙**:任何 AI 的 prompt 只能经 `src/core/agents/context.ts` 构建。玩家上下文 = 公开事件流(按座位视角过滤) + 自己的角色卡 + 自己持有的线索 + 与自己相关的私聊。`truth`/他人私卡在类型与代码路径上双重不可达。新功能不得新增绕过 `buildPlayerContext/buildDmContext` 的取数路径。
2. **前缀缓存不变式**:`cacheFriendlyMessages`(context.ts)要求同一座位 system 消息整局不变。技能/测验等动态指令一律放 user 尾部;hostGuideBlock 的先例可参照。
3. **并发模型**:`engine.ts` 所有状态变更必须走 `exclusive()`;慢速 LLM 调用走 `scheduleBackground()`(参照 `queueAiVote`/`queueAiWhisper`:锁外调用、锁内短暂提交)。事件只经 `recordEvent()` 落库(自动 SSE 广播 + 写内存 + 触发摘要/向量化)。
4. **旧档兼容**:`GameState` 新增字段必须在 `GameEngine.load()` 里 `??=` 补默认(参照 `state.pendingPublish ??= {}` 一段)。Schema 新字段必须全部带 `.default()`,保证 33 本存量剧本零改动可解析,且 `npx tsx scripts/validate-script-v2.ts` 对全部种子保持 **0 error**(这是硬门槛)。
5. **双视角渲染**:每新增一种 `EngineEvent.type`,必须同时改两处——`src/core/engine/state.ts` 的 `renderEventLog`(给 LLM 看的文本)和 `src/app/play/[gameId]/page.tsx` 的 `EventBubble`(给玩家看的气泡);并把新类型加进 SSE 处理器的概要刷新触发列表(page.tsx 内 `ev.type === "clue" || ...` 那行)。
6. **验收命令**(每个里程碑结束都要跑):
   ```bash
   npx vitest run                 # 全部通过
   npx tsc --noEmit               # 0 错误
   for f in seeds/*.json seeds/generated/*.json; do npx tsx scripts/validate-script-v2.ts "$f" 2>&1 | head -1; done   # 33/33 error=0
   npx eslint src --quiet         # 0 输出
   npm run script:schema          # 若改了 Zod,再生成 schemas/script-input-v2.schema.json(schema.test.ts 会校验一致性)
   ```
   全部完成后(且只在全部完成后):`npm run build && pm2 restart jubensha`,再用 `node scripts/smoke-m3.mjs` 跑冒烟(默认打 :3000;可用 `SMOKE_BASE=http://127.0.0.1:3001 npx next start -p 3001` 先在临时端口验证,测完清理对局)。
7. **测试规范**:纯函数测试放对应模块 `*.test.ts`(参照 `src/core/script/v2/v2x.test.ts`、`src/core/agents/memory.test.ts` 的写法,seed 用 `seeds/sample-5p-cloudlanshan.json`);不写依赖 DB/LLM 的测试。每个里程碑附 8-15 个新断言。
8. 文档同步:完工后更新 `README.md`(功能/已知限制)与本计划文档的勾选状态。

---

## 里程碑 M1:线索交易(最小,先行)

**目标**:讨论阶段,持卡人可以把一张**未公开**线索卡私下面交给另一座位;双方可见(转交事件),AI 收卡后自动在其上下文中获得该线索。

### 1.1 Schema(`src/core/script/v2/schema.ts`)
- `flowV2Schema` 增加:`allowClueTransfer: z.boolean().default(false)`。
- 不改 clue/其他结构。33 本不受影响。

### 1.2 引擎(`src/core/engine/engine.ts` + `types.ts` + `state.ts`)
- `GameState` 不需要新字段(`heldClues` 即持有权唯一事实源)。
- `GameAction`(engine.ts 顶部 union)与 actions 路由的 zod(`src/app/api/games/[id]/actions/route.ts`)同步新增:
  ```ts
  type: ... | "transfer",
  clueId?: string, toSeat?: number,
  ```
- `handleActionInner` 新增 `case "transfer"` 校验链(全部通过才执行):
  1. `state.phase === "DISCUSSION"`;
  2. `this.script.flow.allowClueTransfer === true`,否则返回"本局不支持线索转交";
  3. `toSeat` 是 activeSeats 内且 ≠ 自己;
  4. `(state.heldClues[seatIndex] ?? []).includes(clueId)`;
  5. 线索未公开:`state.clueStates[clueId]?.isPublic !== true`(公开卡转交无意义)。
- 执行:
  ```ts
  state.heldClues[seatIndex] = held.filter(id => id !== clueId);
  state.heldClues[toSeat] = [...(state.heldClues[toSeat] ?? []), clueId];
  await this.recordEvent({ type: "transfer", phase, round, fromSeat: seatIndex, toSeat, visibility: `seat:${toSeat}`, content: { clueId, clueName, clueContent: clueText(clue), text: `${this.speakerName(seatIndex)} 悄悄把一张线索卡交给了你。` } });
  await persistState(...); return { ok: true };
  ```
  可见性说明:`visibility: seat:${toSeat}` + `state.ts` 的 `visibleTo` 已有 `event.type === "private" && event.fromSeat === seatIndex` 规则——把该规则同时用于 `type === "transfer"`(或在 renderEventLog 里按 private 同样处理),双方可见、旁观者不可见。真人 DM 视角天然全见。
  **注意:`src/app/api/games/[id]/events/route.ts` 顶部还有一份独立的 `visibleTo` 副本(SSE 投递过滤用),两处必须同步修改**,否则会出现"落库渲染正确但浏览器收不到事件"的诡异现象。
- `types.ts`:`EngineEvent["type"]` union 加 `"transfer"`;`state.ts` `renderEventLog` 加 case(输出 `【线索转交】你收到/交出「name」: content`);防火墙自动成立——收卡后 `heldCluesOf` 即把它当作收卡人持有的线索进上下文,`guardPlayerSpeech` 的 heldByMe 判断也随之正确。
- 注意:`clueStates[clueId].discoveredBy` 不改(谁是发现者的历史事实),持有权只看 `heldClues`。

### 1.3 前端(`src/app/play/[gameId]/page.tsx` + `src/lib/client.ts`)
- `GameSummary.flow` 已整体透传(`doc.flow`),`allowClueTransfer` 自动可用;`GameSummary` 类型里 flow 补字段标注。
- EventBubble 加 `case "transfer"`(参照 private case 的样式,复用 secret-400 虚线风格,文案"线索转交")。
- 右栏「我的线索」页签:当 `flow.allowClueTransfer && phase === "DISCUSSION" && !isPublic` 时,卡片上出现"转交"按钮 → 弹出座位选择(排除自己)→ 调 `actions` API `{"type":"transfer","clueId","toSeat"}`;成功后该卡从我的列表消失(下一个 summary 刷新自然生效——把 `"transfer"` 加进 SSE 概要刷新触发类型)。

### 1.4 测试(`src/core/script/v2/v2x.test.ts` 或新文件)
- `allowClueTransfer=false` 时 transfer 被拒(需要 mock engine?不可——engine 依赖 DB。改为:把校验链抽成纯函数 `validateTransfer(script, state, fromSeat, clueId, toSeat): string | null` 放 `flow.ts`,测试纯函数;引擎 case 调用它)。
- 纯函数覆盖:未持有/已公开/非讨论期/目标非法/flow 关闭 五种拒绝 + 一种通过。
- renderEventLog 的 transfer 渲染断言(玩家视角 vs 无关座位视角)。

### 1.5 验收
- 用 `seeds/sample-5p-cloudlanshan.json` 手动开启 `allowClueTransfer` 的临时副本做冒烟(可选);单测 + 全量验收命令通过即可。

---

## 里程碑 M2:技能卡与行动点(质询)

**目标**:角色卡可携带技能卡;讨论阶段消耗行动点使用【质询】技能,强制目标 AI 座位当众正面回答一个提问(AI 不允许回避)。给真人"点验 AI"的硬工具。

### 2.1 Schema(`src/core/script/v2/schema.ts`)
```ts
const skillSchema = z.object({
  id: idSchema,
  name: leafText,                       // 如「当场对质」
  description: leafText,                // 玩家可见说明
  cost: z.number().int().min(1).max(3).default(1),
  phase: z.enum(["SEARCH", "DISCUSSION"]).default("DISCUSSION"),
  effect: z.enum(["verify"]).default("verify"),   // v1 仅 verify;预留扩展
  once: z.boolean().default(true),
}).strict();
```
- `privateCardSchema` 增加 `skills: z.array(skillSchema).default([])`。
- `flowV2Schema` 增加 `actionPointsPerRound: z.number().int().min(0).max(3).default(0)`(0 = 功能关闭)。
- 校验器(`validate.ts`):`cost <= flow.actionPointsPerRound` 否则 warning("技能消耗超过每轮行动点,将永远无法使用")。

### 2.2 引擎
- `GameState`:`actionPoints?: Record<string, number>`(座位→剩余点)、`usedSkills?: string[]`(键 `${seat}:${skillId}`)。`load()` 补默认。
- 每轮重置:`transitionSearch`/`transitionDiscussion` 开头 `state.actionPoints = {}`,然后对每个 activeSeats 置 `String(seat) -> flow.actionPointsPerRound`(仅当 >0)。
- 动作:`"use_skill" { skillId, toSeat?, text? }`,handleActionInner 校验链:
  1. `flow.actionPointsPerRound > 0`;
  2. 阶段 == skill.phase;
  3. 自己角色卡持有该 skill(`characterOf(...).privateCard.skills`);
  4. `once` 技能未用过(`state.usedSkills` 不含键);`cost <= (state.actionPoints[seat] ?? 0)`;
  5. effect=verify:`toSeat` 是 AI 座位且 ≠ 自己、`text` 非空(≤200 字)。
- 执行(verify):扣点/标记 used → `state.pendingAnswer = { fromSeat, toSeat, question, forced: true }`(类型加 `forced?: boolean`)→ `recordEvent({ type: "system", toSeat: null, visibility: "public", content: { text: `${我} 动用了技能【${name}】,要求 ${对方} 当众正面回答:${text}` } })` → persistState → `continueTick()`。后续走既有 `resolvePendingAnswer` 的 AI 分支,只需把 forced 透传给 `aiSpeak` 的 hint:`【技能质询】这是被技能强制要求的回答:必须正面回应问题本身,不得回避、不得反问、不得转移话题(可以藏秘密,但答案要对得上问题)`。
- 人类目标不支持(返回明确错误"质询技能只能对 AI 玩家使用");同样抽纯函数 `validateUseSkill(...)` 放 flow.ts 供测试。

### 2.3 Agent/上下文
- 无需新 agent 方法:`resolvePendingAnswer` → `aiSpeak` → `buildPlayerContext` 已覆盖;forced 只改 hint。**不要**动 system(缓存不变式)。
- 防火墙确认:hint 文本由引擎拼装,含公开事件即可。

### 2.4 前端
- 概要 API(`src/app/api/games/[id]/route.ts`)在 `mySeat !== null` 时追加:
  ```ts
  skills: 我的技能卡数组(含 usable 标记: 阶段/点数/once 计算),
  actionPointsLeft: number,
  ```
  (`client.ts` GameSummary 同步类型。)
- 左栏行动面板新增「技能」区:每张卡一个按钮,disabled 原因用 title 提示(点数不足/已使用/不在阶段);点击弹出提问输入框(复用 ask 的交互样式)→ 提交 `use_skill`。
- EventBubble 无新事件类型(system 承载公告)。

### 2.5 测试
- `validateUseSkill` 纯函数:七种拒绝(功能关闭/阶段错/无此技能/once 已用/点数不足/目标非 AI/问题为空)+ 通过。
- `resolvePendingAnswer` 的 forced hint 透传:把 hint 拼装抽成纯函数 `forcedAnswerHint(question)`,断言包含"不得回避"。
- GameState.load 兼容:不测(需 DB),靠 `??=` 模式审查。

---

## 里程碑 M3:结构化结局与多选项投票

**目标**:打破"二元结局"天花板。支持 `voteMode`:culprit(现状)/hybrid(指凶+答题)/choice(纯答题,还原本/情感本)。答题结果进复盘,人人可见全场作答分布与个人得分。

**参照设计**(开源 [ai-jubensha-fusion](https://github.com/w93139/ai-jubensha-fusion) 的 FinaleRules,可只读其 `backend/src/schemas/finale_rules.py` 找感觉;本计划已把需要的部分简化如下,以本计划为准)。

### 3.1 Schema
```ts
// flowV2Schema 增加:
voteMode: z.enum(["culprit", "hybrid", "choice"]).default("culprit"),

// quiz 问题(v1 仅单选;多选留扩展位)
const quizOptionSchema = z.object({ id: idSchema, label: leafText }).strict();
const quizQuestionSchema = z.object({
  id: idSchema,
  prompt: leafText,
  options: z.array(quizOptionSchema).min(2).max(6),
  correctOptionId: idSchema,
  weight: z.number().int().min(1).max(3).default(1),
}).strict();

// scriptDocV2Schema 的 ending 改为:
ending: z.object({
  outcomes: z.array(outcomeSchema).length(2),   // 保持不变(culprit 两结局;choice 模式下也保留,作escaped/caught文案位)
  quiz: z.array(quizQuestionSchema).default([]),  // 空 = 无答题
}).strict();
```
- 校验器新规则(`validate.ts`):
  - `voteMode === "culprit"` 且存在 quiz → warning("culprit 模式忽略 quiz,如需答题请用 hybrid/choice");
  - `voteMode !== "culprit"` 且 `quiz` 为空 → error;
  - 每个 question:`correctOptionId` 必须在 options 内(error);options id 唯一(error);question id 唯一(error);
  - `weight` 总和 ≥ 1(天然满足)。

### 3.2 引擎
- `GameState`:`quizAnswers?: Record<string, Record<string, string>>`(座位→问题id→选项id),`load()` 补默认 `??= {}`;`quizResult?: { perSeat: Record<string, { correct: number; total: number; score: number }>; perQuestion: Array<{ questionId: string; counts: Record<string, number>; correctOptionId: string }> } | null`。
- 完成判定抽纯函数(flow.ts):
  ```ts
  export function finaleMissing(state, opts: { voteMode; seats: number[] }): { votes: number[]; quiz: number[] }
  ```
  - culprit:只看 votes;choice:只看 quiz;hybrid:两者。VOTE 阶段 `step()` 用它替换现有 `missing` 计算。
- 动作:
  - culprit/hybrid 的 `vote` 动作保持原样;
  - 新动作 `answer_quiz { answers: [{ questionId, optionId }] }`:仅 choice/hybrid;一次性锁定(已答则报"已作答");全量提交(每次提交全部题目的答案,前端整卷提交);校验 questionId/optionId 存在且属于该题。
- `queueAiVote` 处理 votes;新增 `queueAiQuiz(seat)`(同模式,锁外 LLM):agent 新方法 `quizAnswer(ctx, seatIndex, questions)`:
  ```ts
  requireJson = `复盘在即,请根据你的情报与推理作答。请只输出 JSON:{"answers":[{"questionId":"...","optionId":"..."}]}。必须每题都答。` + 题目清单(id/prompt/选项)
  temperature 0.4, purpose seatPurpose
  ```
  解析失败/缺题的兜底:随机合法选项(保证流程闭环)。
- VOTE 阶段 `step()`:
  - 对每个缺失者:AI → queueAiQuiz + (hybrid 时)queueAiVote;human → armHumanTimeout(超时兜底:hybrid 随机投+随机答,choice 随机答)+ 定向 system 提示"请作答(含答题卡)"。
  - `finaleMissing` 全空 → `transitionReveal()`。
- `transitionReveal` 改造(**保持 culprit 行为逐字节不变**):
  - 计算 `state.quizResult`(quiz 非空时):perQuestion 作答分布 + 正确项;perSeat 得分(对/总/百分)。
  - hybrid:照旧公布投票结果与凶手,追加"答题点评"任务与 quiz 统计;choice:跳过票型公布,任务改为"宣读每题正确答案与全场分布,按得分点评全场还原度"。`caught` 在 choice 模式仍按投票结果算(hybrid)或恒 false(choice)——choice 的 winText 用 escaped 文案位承载"复盘总结"语义,并在 README 已知限制中写明。
  - reveal 事件 content 追加 `quiz: this.state.quizResult`(前端渲染)。
- `recordVote`/Vote 表不动;quiz 结果只进 state+事件(不建表,留迁移需求到后续)。

### 3.3 前端
- 概要 API(`mySeat` 门控)追加:`voteMode`、`quiz: { questions: [{id,prompt,options}], myAnswers: Record<qid,oid> | null }`、ENDED 后 `quizResult`。`client.ts` 类型同步。
- 投票面板:`voteMode !== "culprit"` 时在投票(如有)下方渲染答题卡(每题一组单选,radio);choice 模式隐藏指凶区。提交按钮分开发 `answer_quiz`。
- Reveal 幕:quiz 非空时渲染成绩单——每题正确答案+各选项票数、我的得分与全场平均。样式复用 reveal-stage。
- SSE 概要刷新触发列表把 `"transfer"`(M1)与 VOTE 相关既有类型覆盖确认。

### 3.4 测试
- 纯函数:`finaleMissing` 三种 voteMode × 空满矩阵;
- validator:choice 无 quiz → error;correctOptionId 不在 options → error;culprit 带 quiz → warning;
- 引擎侧抽纯函数 `computeQuizResult(questions, answers)`:分布/正确/得分计算(空答、全对、加权);
- agent `quizAnswer` 的 requireJson 构造抽纯函数 `quizPrompt(questions)`,断言含题干与 JSON 模板。

### 3.5 可选加分项(做完主线再考虑)
- 新增一本演示种子 `seeds/generated/sample-4p-quiz.json`(4 人 choice 模式,3 道还原题),让冒烟可覆盖新链路;并跑 `npx tsx scripts/sync-seed-scripts.ts --write` 入库。

---

## 通用收尾清单(三个里程碑各自完成后执行)

1. `npx vitest run && npx tsc --noEmit && npx eslint src --quiet` 全绿;
2. 33 本 validator 0 error;
3. 改过 Zod → `npm run script:schema` 再生成;
4. `README.md`:功能清单与「已知限制」更新(choice 模式结局文案语义、verify 仅对 AI、transfer 仅 DISCUSSION 等边界);
5. 本文档勾选对应里程碑的完成状态;
6. `git` 提交(一个里程碑一个 commit,信息格式参照仓库现有 `feat:` 风格);
7. 全部里程碑完成后统一:`npm run build && pm2 restart jubensha && node scripts/smoke-m3.mjs`( smoke 需 dev/生产服务在 :3000;生产重启后即可直接跑)。

## 风险与已知坑(前车之鉴)

- `transitionReveal` 有并发双触发守卫(`if (this.state.voteResult) return`),quiz 分支必须共用同一守卫,别新开状态位。
- `resolvePendingAnswer` 走 AI 与人类两条路;verify 的 forced 只影响 AI 分支的 hint,人类被质询仍走既有"回答/拒绝"交互(不要改人类语义)。
- 前端 `page.tsx` 的 SSE `es.onmessage` 是手写 union 类型,新增事件/字段记得同步 `as` 类型与 `GameSummary`。
- 引擎是单例内存 + DB 快照:重启恢复靠 `load()`,新 GameState 字段漏 `??=` 会导致旧档undefined崩溃。
- choices/answers 的一次性锁定语义与 vote 保持一致(重复提交返回"已作答"),前端据此禁用按钮。
- 遇到与计划冲突的代码现状:以"最小侵入 + 向后兼容"为准绳,并在 PR/commit message 里说明偏差。
