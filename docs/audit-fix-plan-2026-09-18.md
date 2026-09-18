# 全面审查整改计划（2026-09-18）

依据 2026-09-18 独立审查报告（UI / 功能逻辑 / 代码质量 / 安全性能 四维度）制定。
原则：**每批独立可验证、独立可提交**；P0 全部完成前不启动 P2 的美化类工作；每批收尾必须 `npx tsc --noEmit` + `npm test` 全绿，涉及引擎的批次另跑 `engine.longflow.test.ts`。

## 批次总览与依赖

| 批次 | 内容 | 预估 | 依赖 |
|---|---|---|---|
| A | P0 安全四修 | 0.5 天 | 无 |
| B | P0 引擎卡死三修 | 1 天 | 无（与 A 可并行） |
| C | P0 UI 基础修复 | 0.5 天 | 无 |
| D | P1 API 健壮性与事务 | 1 天 | B（复用 `abort_game` 语义） |
| E | P1 安全补强 | 0.5 天 | A |
| F | P1 剧本开关接线 | 0.5 天 | B |
| G | P2 性能热点 | 1 天 | D |
| H | P2 UI 体验与可访问性 | 1–1.5 天 | C |
| I | P2 结构治理（拆分/测试/卫生） | 持续 | A–H 之后 |

---

## 批次 A：P0 安全四修

### A1 管理口令爆破面（admin/unlock）
- `src/app/api/admin/unlock/route.ts:7`：`body.token === adminPassword()` 改为常量时间比较——新增 `safeEqual(a,b)`（`crypto.timingSafeEqual` + 长度先哈希对齐），cookie/头校验同步替换：`src/lib/admin.ts:56,58`。
- 该路由接入 `rateLimit`：key 按 IP + `admin:global` 兜底，例如 5 次/分钟。
- 验收：错误口令连续 6 次返回 429；timing-safe 单测（含长度不等用例）。

### A2 默认口令 = 主密钥
- `src/lib/admin.ts:5-8`：删除 `ADMIN_TOKEN || SECRET_MASTER_KEY` 回落链。启动期断言（放 `src/instrumentation.ts` 或 `admin.ts` 首次调用）：`ADMIN_TOKEN`、`SECRET_MASTER_KEY` 均必须已设置、二者不相等、且不等于 `change-me`，否则抛错拒绝启动。
- 更新 `.env.example` 注释说明强约束；`README` 部署段同步。
- 验收： unset 或复用值时进程启动即失败并给出明确错误文案。

### A3 未认证唤醒引擎烧钱
- `src/app/api/rooms/[code]/route.ts:15-49`：GET 加 `rateLimit`（IP 桶 + 全局桶），返回体不再直接暴露 `gameId`（改由持有 seat/dm 凭证的子接口换取）。
- `src/app/api/games/[id]/route.ts:29-31`、`src/app/api/games/[id]/events/route.ts:61-63`：`GameEngine.load → resumeAfterLoad` 仅在请求携带有效 seatToken/dmToken 时触发；无凭证请求只读快照、不重挂 AI 回合。
- 验收：无凭证轮询 running 局不产生 LLM 调用（用 `client.test.ts` 的 mock 计数断言）；房间码枚举被限流。

### A4 限流自我清空
- `src/lib/rate-limit.ts:26`：`buckets.clear()` 改为 LRU 逐出（Map 迭代序即插入序，逐出最旧的非全局桶；`*:global` 键永不删除）。
- 验收：单测模拟 >5000 个不同 XFF 的桶灌入后，`join:global` 计数仍有效。

---

## 批次 B：P0 引擎卡死三修（src/core/engine/engine.ts）

### B1 READING 阶段兜底
- `engine.ts:1109-1115`：READING 分支对未 ready 真人挂 `armHumanTimeout`（`unlimitedHumanTurns` 语义沿用），到点自动代答 ready；`engine.ts:1690-1718` 扩展阶段集合。
- `handleDmAction`（`engine.ts:2077-2087` 附近）：新增 `force_ready`（代指定座位 ready）与 `abort_game`（写入 schema 已预留但全库无写入点的 `aborted` 终态，广播原因）。
- 验收：longflow 新用例——一名真人永不 ready，到截止后对局自动推进；`abort_game` 后所有写接口拒绝再接受动作。

### B2 定时器键空间冲突
- `engine.ts:426-453,483,505-511,551,1696`：`this.timers` 键统一加命名空间：人类计时 `human-turn:${seat}`、代答调度 `gen:${token}`；`clearTimers` 改按精确前缀分组清除，禁止裸 `startsWith("turn:")`。
- `src/lib/human-timeout.ts:24`：`needsHumanDeadline` 增加交叉校验——`humanDeadlines` 有未来值但对应定时器不存在时重挂（自愈）。
- 验收：新回归测试覆盖 seat≥1 且 turnToken 数值重叠的场景（现 `engine.longflow.test.ts:125` 只测 seat 0 的盲区）。

### B3 技能质询计时器
- `engine.ts:1959-1986`：`use_skill` 质询提交时 `clearHumanTimeout(提问者 seat)`，作答链路结束（`submitAnswer` 或答案超时）后重挂当前回合计时。
- `engine.ts:686`：`dispatchAnswerTurn.stale()` 增加 `turnSeat` 边界校验，防止把答案记到已失效回合。
- 验收：新用例——AI 作答耗时跨过提问者原截止，不出现「误报超时 + 答案丢弃」；`markSpoken` 只发生在正确 seat。

---

## 批次 C：P0 UI 基础修复

### C1 色阶 token 补齐
- `src/app/globals.css` `@theme`：补 `--color-paper-100/300`、`--color-clue-300`、`--color-danger-300`（值从相邻色阶内插，保持墨金主题）。
- 验收：`grep` 全 app 使用的 `text-*(paper|clue|danger|gold|ink)-\d` 类在编译 CSS 中全部存在（可写一次性校验脚本，任务完成后删除）。

### C2 加载失败错误态
- `src/app/play/[gameId]/page.tsx:108-135`：加载加 try/catch + `loadError` 状态，渲染错误卡片与「重试」按钮，替换永停「进入对局…」。
- `src/app/rooms/[code]/page.tsx:37-41`：轮询回调包 try/catch，连续失败 N 次显示断线条纹条与手动重试；`document.hidden` 时暂停轮询。

### C3 错误可见性
- `play:783-845`：DM 控制台/观众态渲染 `error` 通道（轻量 banner，不阻断聊天）。
- `src/app/settings/page.tsx:627`：消息按 `tone: "ok"|"err"` 上色，校验错误不再用 `text-emerald-400`。

### C4 设计系统收敛（本批只做地基）
- 新建 `src/components/ui.tsx`：`<Button variant=gold|ghost|danger>`、`<Input>`、`<Card>`，基于 token 色。
- 后续批次 H 再逐页替换 zinc/amber 页面（rooms/new、rooms/[code]、scripts、generate、settings、ScriptDetail），不在本批展开。

---

## 批次 D：P1 API 健壮性与事务

- D1 统一 handler 包装：新增 `src/lib/api.ts` 的 `withRoute(handler)`——try/catch、zod 错误 400、内部错误 500 且**不回显 err.message**；21 个 API 路由逐个接入。`actions/route.ts:38` 对 `GameEngine.load` 抛错时降级为只读快照视图；`games/[id]/route.ts:20` 补 `scripts/[id]/route.ts:116` 已有的 `parseOrCanonical` 降级。
- D2 开局事务：`rooms/[code]/start/route.ts:60-61` 用 `db.$transaction` 包住「置 playing + 建 game」，失败回滚为 waiting；`Game.roomId @unique` 冲突捕获后返回 409 而非 500。`rooms/route.ts:53-58` 房间码改 `retry on unique violation`。`rooms/[code]/route.ts:87-100` 多座位 update 入同一事务，并复检 min/maxPlayers。
- D3 事件/快照一致性：前端 `play:185-187` 事件触发的概要重拉加 300ms 防抖 + 尾随合并；`engine.ts:1770` `recordVote` 的 `db.vote` 写入失败改为记入 state 补偿队列并 `systemSay` 告警 DM，不再静默吞。
- D4 凭证入 header：`lib/join.ts:66-73`、`games/[id]`、`dm-actions` 的 seatToken/dmToken 改 `Authorization: Bearer` 或自定义头，query 兼容期一个版本后删除。

## 批次 E：P1 安全补强 ✅（2026-09-18 验收：url-guard 6 用例全绿；生产构建 curl 确认四安全头生效；providers 401 鉴权正常；commit 待工作树整理后补）

- E1 SSRF：`src/app/api/providers/route.ts:10` 校验 baseUrl——解析主机、拒绝私网/回环/链路本地段（含云 metadata IP），`providers/test/route.ts:46` 与 `provider-url.ts:13-28` 探测路径复用同一守卫。
  - 落地为 `src/lib/url-guard.ts`：元数据/链路本地/`.internal` 无条件封；回环/RFC1918 默认放行（兼容本机 Ollama），`ALLOW_PRIVATE_PROVIDER_URL=0` 收紧；域名解析后逐 IP 校验。
- E2 错误回显过滤：`src/core/llm/client.ts:377` 抛给引擎的消息脱敏（去掉上游原始报文，保留 provider 名与状态码）；`api/settings/database/route.ts:39,59`、`api/tts/route.ts:50` 不再直返 `err.message`。
- E3 限流覆盖：`rooms/route.ts:29`（建房）、`games/[id]/actions`（动作）、`POST /api/tts` 各加桶。
- E4 `next.config.ts`：加 `X-Content-Type-Options`、`Referrer-Policy: same-origin`、基础 CSP（先 report-only 观察一周再收紧）。

## 批次 F：P1 剧本开关接线 ✅（2026-09-18 验收：engine.longflow 新增 3 用例全绿，全量 204 用例；commit 待工作树整理后补）

- `selfIntroRounds`、`allowPrivateChat`、`privateChatMessageLimit`（`src/core/script/v2/schema.ts:275-279`）在 `engine.ts` 消费：自我介绍轮数取配置；`allowPrivateChat=false` 时拦截 AI 私聊派发；私聊限额到次后封口（修正 `engine.ts:2028` 直接置 0 的一次性语义）。
  - 落地：`advanceSelfIntroRound` 多轮自我介绍；`maybeQueueWhisper` 与 `private_chat` 动作双端 `allowPrivateChat` 门；窗口额度封顶 `privateChatMessageLimit`、真人回复逐次 `-1` 消耗。
- `types.ts:57` `interjections` 的 `@deprecated` 注释与 `engine.ts:235,241,244` 实际用途矛盾——确认语义后二选一：删注释或删计数。
  - 落地：插话功能实际在用（mention 调度 + 每轮上限），删 `@deprecated`、注释改为如实描述计数语义。
- 验收：三开关各一条引擎用例（开/关行为差异可断言）。

## 批次 G：P2 性能热点 ✅（2026-09-18 验收：205 用例全绿；索引迁移已 deploy；坏 last-event-id 冒烟不再 500；commit 待工作树整理后补）

- G1 剧本解析缓存：`src/core/script/compat.ts:26` 按 `scriptHash` 进程内 LRU（≤50 本）缓存解析+迁移结果；配合 rooms 页轮询即消除首要热点。
  - 落地：`parseScriptForRuntime` 以内容 sha256 为键的 LRU（≤50），命中返回共享只读对象；compat.test 增加引用相等/失效用例。
- G2 N+1：`api/rooms/[code]/route.ts:87-100`、`start/route.ts:53-58`、`engine.ts:171-173` 循环单条写改 `updateMany`/`createMany` + `$transaction`。
  - 落地：rooms PATCH 已在 D 批入 `$transaction`；start 的 AI 默认名循环改批量事务；engine 开局 seatState 初始化改 `createMany`（失败回落逐条）。
- G3 内存回收：`engine.ts:21` engines Map 与 `bus.ts:9` buses 在终局落库后延迟驱逐（如 10 分钟），加 `globalThis` 缓存上限告警日志；`engine.ts:94` 初始事件读取加 `take` 上限（取最近 N + 总数）。
  - 落地：`finalizeEnded` 挂 10 分钟 unref 定时器驱逐（仅当仍是同一实例且 ENDED）；`evictBus` 只在无订阅者时删除；`rememberEngine` 软上限 200 告警；恢复只回放最近 800 条事件（count+desc take）。
- G4 `events/route.ts`：`BigInt(last-event-id)` try/catch 降级为从头重放（41）；订阅成功但历史查询抛错时确保 `cancel()` 走清理路径（91-104）。
  - 落地：解析失败回落 `BigInt(0)` 全量重放；历史回放包 try/catch，失败仅放弃补发、保住实时订阅与心跳清理链。
- G5 TTS：`src/core/tts/index.ts:57` 缓存加容量上限 + LRU 淘汰。
  - 落地：每次新写入后惰性修剪——超过 500 条即按最旧创建时间成批（20）删除记录与音频文件；修剪失败不影响合成。
- G6 `prisma/schema.prisma`：`UsageLog` 补 `@@index([createdAt])`、`@@index([gameId])`，出迁移。
  - 落地：`20260918120000_usage_log_indexes` 已 `migrate deploy` 到本机库。

## 批次 H：P2 UI 体验与可访问性 ✅（2026-09-19 验收：src/app+src/components 旧色板类清零（含补迁 ScriptDetail）；全站控件 label 关联核查通过（sr-only/label 包裹/aria-label 三种方式）；聊天流 role=log+aria-live、右栏 tablist/aria-selected、导航 aria-current、弹窗 role=dialog+Esc+焦点圈定+关闭归还焦点（浏览器实测）；settings 表格 overflow-x-auto+骨架；play 贴底浮标/发言失败保留文本/lg 两栏；tsc 0 错误、205 用例全绿、lint 0 error、生产构建+pm2 冒烟通过；commit 待工作树整理后补）

- H1 替换 zinc/amber 页面到 C4 的 `<Button/Input/Card>`（逐页 PR：rooms/new → rooms/[code] → scripts → generate → settings → ScriptDetail）。
- H2 交互兜底：`play:217-219` 贴底判断（用户上滑则显示「回到底部」浮标）；`play:1023-1041` 发言失败保留输入文本；`play:529,575-583` 补 `disabled={sending}`。
- H3 a11y：聊天流 `role=log` + `aria-live=polite`；select/input 补 `aria-label` 或关联 label；tab 组 `role=tablist`/`aria-selected`；导航 `aria-current`；`scripts/page.tsx:65-75` 导入按钮改 `sr-only` input + label；弹窗 `role=dialog` + Esc + 焦点圈定；图标按钮扩点击区至 32px+ 并加 `aria-label`。
- H4 响应式：`settings:653-678` 表格外包 `overflow-x-auto`；`play:474` 增加 md/lg 两栏过渡布局；消除 `play:858,872` `min-h-[70vh]` 与内联 72vh 叠加，统一为 flex 列。
- H5 对比度：元信息色从 `paper-500` 提到 `paper-400`（≥4.5:1）；`globals.css:43,52,64` 硬编码色并入 token。
- H6 空态/死码：`settings:293,411` 首帧未加载前显示骨架而非空态文案；`scripts/generate:24` 删除未用的 `"outline"` 阶段。

## 批次 I：P2 结构治理（不阻塞发布，按机会执行）

- I1 `engine.ts` 按 phase 拆 handler + 提取 `TurnScheduler`（B 批的定时器命名空间改造是其自然前奏）。✅（2026-09-19）
  - 落地：`engine.ts` 2263→981 行，只保留门面（构造/注册、recordEvent/persist、exclusive/schedule、tick/step、handleAction/handleDmAction）。拆出 8 个兄弟模块：`util/registry/turns/phases/social/search-deal/discussion/finale/human-turn`，均以 `(e: GameEngine, ...)` 注入 + type-only 回 import，运行时导入图验证无环；`TurnScheduler` 即 `turns.ts` 的 `dispatchTurn`（锁外 produce→锁内 token/边界双重校验 commit→看门狗强制推进）。longflow 测试 3 处 `maybeQueueWhisper` 改调 `social.ts` 导出版；顺带清理 `social/recall/snapshots` 三处死导入。验收：tsc 0 错误、205 用例全绿、lint 0 告警、生产构建+pm2 重启+SSE 续传冒烟通过。
- I2 解循环依赖：`core/agents ↔ core/engine`——把 `context.ts` 依赖的 `flow` 类型下沉到 `core/engine/types.ts` 或新建 `core/shared`。✅（2026-09-19）
  - 落地：`PlayerActionPlan` 接口定义自 `agents/plan.ts` 下沉到 `engine/types.ts`（它本就持久化于 `GameState.actionPlans`），`types→plan→context→flow→types` 类型环消除；运行时值导入图核查 `engine/types|state|flow|bus` 与 `core/llm` 已零 agents 依赖，agents→engine 只剩单向。tsc 0 错误、205 用例全绿、lint 0 告警（纯类型搬迁，编译产物等价）。
- I3 `play/[gameId]/page.tsx` 1410 行拆分：`useGameStream`（SSE/事件）、`ChatFeed`、`DmConsole`、`VotePanel` 四件套。✅（2026-09-19）
  - 落地：页面 1493→547 行，拆出 `src/app/play/[gameId]/_components/` 下 5 个文件——`useGameStream.ts`（254 行：身份加载/SSE 订阅/300ms 尾随刷新/音效/倒计时，保留 streamKey 门控防观战流污染 lastSeq）、`ChatFeed.tsx`（445 行：事件流渲染/贴底滚动/私信回复/复盘 RevealBlock）、`DmConsole.tsx`（89 行）、`VotePanel.tsx`（108 行）、`InfoRail.tsx`（317 行：剧本/线索/时间线三页签+线索持有权推导）。验收：tsc 0 错误、205 用例全绿、lint 0 告警、build+pm2 重启通过；浏览器全进程实测——真人座位注入身份后实玩一整局（答复提问→AI 回合→讨论→投票→真相揭晓「真凶：苏晚」），事件 56→73 全程 SSE 实时推送无重载，控制台零错误。
- I4 提示词收纳：`scripts/generate/route.ts:21-48` 的 SCHEMA_HINT 移入 `core/script`。✅（2026-09-19）
  - 落地：新增 `core/script/schema-hint.ts` 承载 `SCHEMA_HINT`（3857 字符原样搬迁，无 `${`/反引号转义风险），路由改为 import；顺带为常量补充维护说明注释。验收：tsc 0 错误、205 用例全绿、lint 0 告警、build ✓、pm2 重启后 play:200、generate 路由管理门禁正常应答。
- I5 测试补盲：API 路由集成测试（先覆盖 A/D 改动面）、`bus.ts`、`recall.ts`；`events` SSE 断线重连用例。✅（2026-09-19）
  - 落地：新增 4 个测试文件、21 个用例（全库 30 文件/205 用例 → 34 文件/226 用例）——`lib/api.test.ts`（withRoute：4xx 透传、异常→500 固定文案不回显 Prisma 细节、非 Error 抛出物）、`engine/bus.test.ts`（实例隔离、退订、无监听 publish 不抛、evictBus 仅在零监听时驱逐）、`agents/recall.test.ts`（空锚点早退、未绑定时公开线索精确回查、余弦阈值过滤、维度不符向量丢弃、TOP_K 封顶、可见性/锚点边界）、`api/games/[id]/events/route.test.ts`（mock db+engine 的 SSE 路由级测试：lastSeq 增量回放、坏 token 降级观战、有效凭证懒恢复引擎、Last-Event-ID 续传与伪造头降级、历史查询期间总线事件缓冲合并去重、delta audience 过滤、DM 全视角、404）。验收：tsc 0 错误、226 用例全绿、lint 0 告警、build ✓（纯测试新增，无运行时代码变化）。
- I6 小项：`client.ts:289-293` 无意义 try/rethrow、`engine.ts:556-595` 三处重复锁清理、魔法数字提常量（`agents/index.ts:243,257,321` 等）、`page.tsx:36` 一次性字号。✅（2026-09-19）
  - 落地：`chat()` 删恒等 try/rethrow 改直接 `const binding = await resolveBinding(...)`；`engine.ts` 三处重复锁清理已随 I1 门面化完成；`agents/index.ts` 提出 `JSON_DECISION_RETRIES/MAX_SUGGESTIONS/MAX_QUESTION_CHARS/MAX_VOTE_REASON_CHARS/MAX_WHISPER_CHARS` 五常量替换三处重采样循环与四处截断；一次性字号 `text-[11px]` 全库 5 处并回 `text-xs` 阶梯。验收：tsc 0 错误、226 用例全绿、lint 0 告警、build ✓、pm2 重启后 play/home 均 200。
- I7 死码：流式 `delta` 链路（`engine.ts:253,624,676,725` 空 `onDelta`）——要么接线要么删除前端打字机分支。✅（2026-09-19）
  - 落地：选接线而非删除——`streamPlayerSpeech/streamDmNarrate` 本就走 `createSpeechRedactor` 句子级增量守卫（泄露句不放行），流式 delta 即守卫后文本，信息防火墙不破；I1 拆分后的 4 处 `consumeStream(…, () => undefined, …)`（`turns.ts` 玩家发言/质询应答/DM 旁白 + `social.ts` 插话）改推 `publish({kind:"delta", seat, text, audience:"public"})`，`social.ts` 补 bus import。前端 `useGameStream/ChatFeed` 打字机分支原样复用，无协议变更。验收：tsc 0 错误、226 用例全绿、lint 0 告警、build ✓、pm2 重启；新开 5AI 全托管局——裸 SSE 抓到 93 帧 delta（DM 旁白守卫后句子），浏览器观战页 `.typing-caret` 气泡 6→149 字实时增长无重载。教训登记：I5 的纯测试批未触发运行时，pm2 重启必须先 `npm run build`（本轮首次冒烟 delta=0 即因跑旧构建）。
- I8 工作树卫生：当前 28 修改 + 23 未跟踪文件按功能尽快分批提交，勿再滚入下一批。

---

## 里程碑与验收口径

- **M-A（A+B+C 完成，约 2 天）**：可对外测试——无爆破面、无已知永久卡死、无白屏死路。合入标准：新增限流/引擎/错误态测试全绿，`tsc` 0 错误。
- **M-B（D+E+F 完成，约 +2.5 天）**：可小范围公测——API 无 500 风暴、事务完整、开关生效、SSRF 关闭。
- **M-C（G+H 完成，约 +2.5 天）**：体验/性能达标——轮询热点消除、移动端可用、a11y 关键路径通过键盘走通。
- **M-D（I 持续）**：技术债清册，随功能迭代摊还。

每批合入后在本文档对应条目标记 ✅ 并附 commit 哈希，与 `engine-debt-rectification-plan.md` 的执行状态惯例一致。
