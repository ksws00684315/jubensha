# 优化计划进度台账

计划：docs/optimization-plan-2026-09-26.md
工作分支：opt/2026-09　　基线提交：main = 39a81da（2026-09-26 复核）

## 决策记录
| ID | 答复 | 日期 | 备注 |
|---|---|---|---|
| D1 | C：WIP 已在 main 39a81da；opt/2026-09 工作 | 2026-09-26 | 用户批准 |
| D2 | 生产 admin / 开发 open，另实现 invite | 2026-09-26 | 用户批准 |
| D3 | 示例 2,000,000；未设置 = 关闭 | 2026-09-26 | 用户批准 |
| D4 | 允许 push opt/ci-probe 分支；禁 main、禁 force | 2026-09-26 | 用户批准 |
| D5 | 单次 ≤ 300k，P4、P7 各 1 次；无凭证则 SKIPPED | 2026-09-26 | 用户批准 |
| D6 | 允许 @vitest/coverage-v8（同版本） | 2026-09-26 | 用户批准 |
| D7 | Docker 与 pm2 并存 | 2026-09-26 | 用户批准 |

## 指标看板（基线于 S0.4 实测；采集命令见括号）
| 指标 | 基线 | 当前 | 目标 | 最近更新步骤 |
|---|---|---|---|---|
| tsc 错误（npx tsc --noEmit） | 0 | 0 | 0 | S0.4 |
| eslint warning（npx eslint src --max-warnings=0） | 0（S0.2 归零） | 0 | 0 | S0.4 |
| 测试文件 / 用例（npx vitest run） | 55 / 387，约 3.2s | 82 / 648 + 1 expected fail，约 3.0s | 不降 | S4.3 |
| L2 覆盖处理器（find src/app/api -name route.test.ts） | 1/34 | 23/23 个 route.ts 文件都有同名测试（覆盖全部 35 个导出处理器） | 34/34 | S3.5 |
| L2 用例数 | ~10（events route 10 个） | 206 过 + 1 expected fail（`npm run test:api`，24 files，1.2s） | ≥ 140 | S3.5 |
| L3 用例数 | 0 | 15（5 files，15.4s） | ≥ 30 | S4.3 |
| 凭证比较方式（座位 / DM / 房主） | 7 处裸 `===` / `!==` + join.ts 4 处，长度与内容可被计时探测；`games/[id]` 还是 query 优先（BUG-01） | 全部经 `src/lib/credentials.ts`（`timingSafeEqual`，任一侧为空即不匹配），验收 grep `token\s*!==\|!==\s*.*[Tt]oken` 在 `src/app/api` 与 `join.ts` 为空；header 优先已修正。S3.5 的换票端点与 SSE 心跳重验也都走同一套 `verify*` | 无常量时间以外的凭证比较 | S3.5 |
| 含 AI 座位房间的创建授权 | 无检查（任何人可建房消耗 LLM 额度） | 三档策略生效，生产默认 admin；L2 23 用例 + R2 实机 403 + R9 负向清单 403 | 未授权创建/改座 → 403 | S3.1 |
| 单日 LLM token 上限 | 无：授权被绕过后可一路消耗 | `LLM_DAILY_TOKEN_BUDGET` 熔断，`chat`/`chatStream`/`embedTexts` 第一行拦截 + 看板显示今日已用；L1 13 用例 + L3 I11 3 用例 | 超预算不崩溃、对局仍走到 ENDED | S3.2 |
| CSP 执行模式 | 全站只有 `Content-Security-Policy-Report-Only`，含 `'unsafe-eval'`，不拦截任何资源 | 生产 `Content-Security-Policy` 强制、`script-src` 无 `'unsafe-eval'`；开发仍 report-only + eval（Next 需要） | 生产强制 | S3.4 |
| src/lib 行覆盖率（vitest --coverage, L1 口径） | 58.26%（201/345） | 58.26% | ≥ 80% | S0.4 |
| src/app/api 行覆盖率（同上） | 76.14%（67/88） | 76.14% | ≥ 80% | S0.4 |
| src/core/engine 行覆盖率（同上） | 71.98%（1166/1620） | 71.98% | ≥ 基线 | S0.4 |
| 非测试代码 console.*（grep，排除 .test.） | 27 | 34（S3.2 +2：`budget.ts:56/:81`；S3.5 +2：`events/route.ts:40` 废弃 query 凭证告警、`:74` ticket 无效降级告警——两条都是本步判据要求「兼容期记 deprecation 日志」「重放必须可见」所需的，沿用 `[模块]` 直写约定） | 0（log.ts 除外） | S3.5 |
| 非测试代码 as unknown as（grep，排除 .test.） | 12 | 11（S4.3 消掉 `engine.ts` load() 的 `as unknown as GameState`；该模式在 `games/[id]/route.ts:45`、`build-jev-vote-set.ts:68` 仍有 2 处） | ≤ 3 | S4.3 |
| engine.ts 行数（wc -l） | 1044 | 1008（S4.3 把 load() 的 38 行 `??=`/兼容段换成一行 `migrateState` 调用） | ≤ 700 | S4.3 |
| games.state 旧快照兼容方式 | `load()` 里 24 条 `state.x ??=` + 3 段清理，无版本号、无校验、不可测试 | `stateVersion` + `migrateState(raw, {now, gameId})` + zod `.loose()` 校验；7 份 v0 快照 fixtures 常驻 L1/L3 | 版本化迁移可测 | S4.3 |
| handleActionInner 函数体 | :670–:945 ≈ 275 行 | 275 | ≤ 60 | S0.4 |
| games/[id]/route.ts 行数（wc -l） | 185 | 185 | ≤ 70 | S0.4 |
| SSE 稳态 DB 查询/连接/分钟 | 未测 | 未测 | 0 | — |
| npm audit（全量） | 3 high（prisma→@prisma/config→deepmerge-ts，CLI 链路） | 3 high | 不新增 | S0.4 |
| npm audit --omit=dev | 3 high（复测仍含 CLI 链路，见偏差 DEV-01） | 3 high | 0 | S0.4 |
| CI | 无（无 .github/） | 无 | push 自动 check | S0.4 |
| R1 无模型冒烟 | 未测 | 连续 4 次通过，~61s/次（e2e 实例 :3110/:3120） | 连续 3 次 | S2.5 |
| R9 浏览器走查（桌面 1280×800 / 移动 375×812） | 未测 | 两遍各 171 步 0 失败；S3.4 在强制 CSP 下全量重跑 12/12 exit 0（342 步、驱动内 113.2s）；S3.5 再全量重跑 12/12 exit 0（342 步、驱动内 116.4s，桌面 60.2s / 移动 56.2s） | 两遍全绿 | S3.5 |
| R9 控制台 error / 未捕获异常 | 未测 | S3.5 复测：error 2（12 次运行合计，全部是第 1 项故意的 404）/ 异常 0 / **CSP 违规 0** / 步失败 0 | 除故意负向用例外为 0 | S3.5 |
| UI 基线截图（`.e2e/screens/S2.6/`，不入库） | 0 | 142 张：桌面 d01–d31a 32 + 移动 m01–m31a 32（S3.4 基线）+ 决策分支 pd 14 + S3.5 前缀 td 32 + tm 32（同两套清单，不覆盖基线） | ≥ 20 | S3.5 |
| SSE URL 带 `token=` 的请求（R9 网络捕获，每玩家标签页） | 未测 | **0 条**（S3.5 12 次运行合计；同批 `ticket=` 请求 4 条：桌面/移动各在 d3 建连 1 + d5 重连 1，值在报告里掩码）。兼容期 query 通道仍在，但前端已不走它 | 0（S3.5） | S3.5 |
| API 处理器总数（grep export const GET|POST|…） | 34（计划 §1.1 记 35，复测为准） | 35（S3.5 新增 `POST /api/games/[id]/stream-ticket`） | — | S3.5 |
| recordEvent/persist 调用点（src/core 非测试） | 86（计划记 84） | 86 | — | S0.4 |
| engine.events 读取点（`\.events\.` 模式） | 10（`\.events` 宽匹配 26；计划记 19） | 10 | — | S0.4 |
| 种子剧本 V2 文件 | 35（seeds/*.json + seeds/generated/*.json；计划记 25） | 35 | — | S0.4 |

## 步骤状态
| 步骤 | 状态 | 提交 | 开始 | 完成 | 验收证据摘要 | 偏差 |
|---|---|---|---|---|---|---|
| S0.1 | DONE | 80f4cef | 2026-09-26 | 2026-09-26 | 分支 opt/2026-09；main=39a81da 未动；vitest 387 过；已 push -u origin | 无 |
| S0.2 | DONE | 448c374 | 2026-09-26 | 2026-09-26 | tsc 0 / eslint 0 warning / vitest 387 过 / seeds exit 0 | 无 |
| S0.3 | DONE | dca6c52 | 2026-09-26 | 2026-09-26 | .env.example 入库；.zcode 取消跟踪（本地保留）；check-ignore .env 命中 | 无 |
| S0.4 | DONE | （本提交） | 2026-09-26 | 2026-09-26 | 台账建立，§1.1 指标全部实测（见上表）；coverage 基线已装 @vitest/coverage-v8@4.1.11 | DEV-01 |
| S1.1 | DONE | 0b1e10d | 2026-09-26 | 2026-09-26 | npm run check 10.4s 绿；test:api 只跑 api；负向类型错误被拦截 | 无 |
| S1.2 | DONE | 9b63fe0 | 2026-09-26 | 2026-09-26 | APP_CONFIG_PATH 读写落盘/回落 env 两用例过；全量 389 过；.env.example 已加说明 | 无 |
| S1.3 | DONE | 4b71bd7 | 2026-09-26 | 2026-09-26 | yaml-lint 过；check job 绿（run 36254901201，39s）；probe lint-fail CI 变红后远端分支已删 | DEV-02 |
| S1.4 | DONE | 24847c0 | 2026-09-26 | 2026-09-26 | hooks:install 后 lint 错误提交被拒（14.5s）；未安装者不受影响 | 无 |
| S2.1 | DONE | f250d85 | 2026-09-26 | 2026-09-26 | 夹具自测 14 用例；events 迁移后 10 用例断言不变；A13 示范 import+setup ≤10 行 | 无 |
| S2.2 | DONE | ff45e32/ed88734/f168fbf/ada4546 | 2026-09-26 | 2026-09-26 | 35 个 A 编号 describe；L2 用例 165 过 + 2 it.fails；api 行覆盖 87.66%；test:api 约 1.2s | 无 |
| S2.3 | DONE | 70133f5 | 2026-09-26 | 2026-09-26 | I01–I04、I06 过；连跑 5 次全绿；误连库名直接拒绝(exit 1)；CI integration job 绿(run 36259803390) | FIND-02 |
| S2.4 | DONE | 57e0304 | 2026-09-26 | 2026-09-26 | 新增 6 个 L3 用例（SEARCH/VOTE/REVEAL 恢复点 + REVEAL→ENDED 推进 + 并发 speak 互斥 + 动作/定时器交错）；连跑 3 次全绿；未改生产代码 | DEV-03 |
| S2.5 | DONE | f25de5c/4b9310e | 2026-09-27 | 2026-09-27 | 实机实例 :3110 隔离跑通 R1×4（61s/次，action_failed=0）、R2、R3、R4；pm2 jubensha 重启计数 25→25 未变；e2e:down 后 jubensha_e2e 计数 0；种子 29 导入 / L3 10 过 / npm run check 绿 | DEV-04, DEV-05, FIND-03 |
| S2.6 | DONE | 79b66f5/（本提交） | 2026-09-27 | 2026-09-27 | R9 清单 1–6 项桌面 1280×800 与移动 375×812 各一遍，6 份清单 ×2 = 12 次运行 exit 0、每遍 171 步 0 失败；截图 64 张；控制台 error 基线 2（均为第 1 项故意的 404）+ 未捕获异常 0；13 个布局采样无横向滚动；公开/私藏两分支与真人票均有 DB 侧证；第 7 项首轮为基线（无可比截图） | DEV-06, DEV-07, FIND-04, FIND-05, FIND-06 |
| S3.1 | DONE | 2ab7417/5dcc91e/dfefd64/f6816a9 | 2026-09-27 | 2026-09-27 | 三种策略与 D2 默认值逐项对上（证据节）；L2 新增 23 用例（A22 14 + A24 9，两文件 21/17），`npm run check` exit 0（78 files / 581 过 + 2 expected fail，6.0s）、`test:api` 188 过、`test:int` 10 过；实机 R1/R2/R3/R4 全绿（实例按生产默认 admin 跑，未放宽），R9 桌面续跑链 115 步 0 失败、新增负向清单 9 步 0 失败 | DEV-08, DEV-09 |
| S3.2 | DONE | 9c32200/7d4c17b/29aa39c/fdc28da | 2026-09-27 | 2026-09-27 | 三入口第一行拦截 + 关闭时零库调用 + 60s 缓存 + ≥ 才拦 + 本地当天口径，L1 13 用例逐条对上（证据节）；计划验收的「关闭时 chat 查询数与改动前相同」以 mock 计数断言覆盖，「超预算对局仍走到 ENDED」由 L3 I11 覆盖（阶段轨迹逐个走完、真人发言 ≥2、模型请求 0）；`npm run check` exit 0（79 files / 595 过 + 2 expected fail，5.9s）、`test:api` 189 过（2.0s）、`test:int` 13 过（4 files，15.2s）；commit 9c32200 单独 worktree 复验 tsc 0 + 13 过 | DEV-10, FIND-07 |
| S3.3 | DONE | 8e44e16/db34130/9aea713/ab7bf76/69f8917 | 2026-09-27 | 2026-09-27 | 9 个文件里的全部裸凭证比较（座位 / DM / 房主，含 SSE 心跳重验与 join 判定）改为 17 处 `verify*` 调用，验收 grep `token\s*!==\|!==\s*.*[Tt]oken` 在 `src/app/api` 与 `src/lib/join.ts` **输出为空**；BUG-01 关闭（header 优先，A28 的 it.fails 翻正 + 补兼容期用例）；L1 新增 12 用例；`npm run check` exit 0（80 files / 609 过 + 1 expected fail，4.0s）、`test:api` 191 过（1.0s）、`test:int` 13 过（14.8s）、`next build` exit 0；实机 R1/R2/R3 全绿（R2 含错 token 403 / DM 200 / 观战与座位流过滤），实例日志异常 0 | DEV-11 |
| S3.4 | DONE | 6dd4872/4205c38/cc093b2/（本提交） | 2026-09-27 | 2026-09-27 | 生产 `Content-Security-Policy` 强制、`script-src` 无 `'unsafe-eval'`（curl 实读），开发仍 report-only + eval（不启 dev 服务、直接对 `next.config.ts` 求值取两分支）；R9 全量重跑 12/12 exit 0、每遍 171 步 0 失败、**CSP 违规 0/12**、未捕获异常 0、控制台 error 2（均为第 1 项故意的 404）；`npm run check` exit 0（80 files / 609 过 + 1 expected fail，3.6s）、`test:int` 13 过（14.9s）；顺带修掉 DEV-10 无效的 e2e 半边（实例真出网 240 条 ≈$0.0100 → 重启后 0）与 R9 清单里从 S2.6 起就是空操作的搜证决策步 | DEV-10（更正）, DEV-12, FIND-08 |
| S3.5 | DONE(deviation) | fe67d54/5b759ef/f9e872c/6e15f2b/（本提交） | 2026-09-27 | 2026-09-27 | 新增 `POST /api/games/[id]/stream-ticket`（header 凭证 → 60s 一次性票据，进程内 Map、用后即删）+ `src/lib/stream-tickets.ts`；events 路由 `?ticket=` 优先、旧 `token`/`dmtoken` query 保留一个版本并记 deprecation 日志；心跳改按签发时凭证快照重验；前端建连先换票再连。R9 全量重跑 **12/12 exit 0、342 步 0 失败、`token=` 请求 0 条 / `ticket=` 4 条、CSP 违规 0**；实机 R1/R2/R3 全绿且 R3 追加段证明「ticket 建流不重不漏、重放被服务端降级、兼容期仍可用」，实例日志里本轮两局 **0 条**降级/废弃告警、`[jev]` 出网 0；L2 新增 A37 8 用例 + A29 附加 6 用例（过期/重放/跨局/心跳），`npm run check` exit 0（81 files / 625 过 + 1 expected fail）、`test:api` 206 过、`test:int` 13 过、`next build` exit 0 | DEV-13, FIND-09（顺带修 L3 I06 竞态）, FIND-04 关闭 |
| S4.3 | DONE(deviation) | 229d2e0/8084efe/（本提交） | 2026-09-27 | 2026-09-27 | `load()` 的 38 行 `??=`/兼容段（原 `engine.ts:183-220`）换成 `:184` 一行 `migrateState(game.state, {now, gameId})`，段内 **`??=` 计数 0**；新建 `state-schema.ts`（112 行，`z.looseObject` 全字段）+ `state-migrate.ts`（123 行，迁移表 + 每次加载的字段补齐/清理 + 文件头的「新增字段怎么升版本」规则），`GameState.stateVersion` / `CURRENT_STATE_VERSION=1` 落地，`initialState` 直接带最新版。fixtures 7 份（READING/SEARCH/DISCUSSION/VOTE/ENDED + 改动前 `jubensha_e2e` 真快照 + 手工「最老格式」）核实均无 `stateVersion`、座位无凭证字段。L1 **23 用例**（判据 ≥8）过、L3 **I07 2 用例**过；零漂移用临时对照副本证明（8 用例过）后按计划删除；R4 换新 build 恢复**改动前**的 v0 快照跑到 ENDED（`R4 PASSED`，落库 `ENDED|stateVersion 1`）；`as unknown as GameState` 3→2、非测试 `as unknown as` 12→11、engine.ts 1044→1008；`npm run check` exit 0（82 files / 648 过 + 1 expected fail，3.0s）、`test:int` 15 过（5 files，15.4s），两个 commit 各自 worktree 复验 tsc 0 / 625→648 过 | DEV-14 |

## 验收证据（每步一节）
### S0.1
- `git branch --show-current` → `opt/2026-09`
- `git status --short` → 空（除已提交的计划文件）
- `git log main --oneline -1` → 39a81da
- `npx vitest run` → Test Files 55 passed / Tests 387 passed
- `git push -u origin opt/2026-09` → 成功（new branch）

### S0.2
- `npx tsc --noEmit` → exit 0，0 行 error
- `npx eslint src --max-warnings=0` → exit 0（0 error 0 warning）
- `npx vitest run` → 55 files / 387 passed（数量与改前一致，未删测试）
- `npm run -s script:validate -- seeds/*.json seeds/generated/*.json` → exit 0
- 改动：删除 `nextAfterSearch` 未使用第三参数（flow.ts），同步 phases.ts:361 与 flow.test.ts 三处调用点

### S0.3
- `git ls-files .env.example` → `.env.example`（已入库）
- `git ls-files .zcode` → 空（已取消跟踪；`ls .zcode/plans/*.md` 两个本地文件仍在）
- `git check-ignore .env` → 命中 `.env`
- .env.example 逐项核对：均为占位符（change-me / 示例连接串）

### S0.4
- 指标采集命令与输出均见「指标看板」括号内命令，数值为 2026-09-26 实测
- `npm install --save-dev @vitest/coverage-v8@4.1.11`（与 vitest 4.1.11 同版本，D6）
- `npx vitest run --coverage` → src/lib 58.26% / src/app/api 76.14% / src/core/engine 71.98%（行覆盖，L1 口径）
- 复测与计划 §1.1 的差异（以复测为准）：处理器 34（计划 35）、recordEvent/persist 86（计划 84）、`.events\.` 读取点 10（计划 19）、种子 35（计划 25，计划注明以 ls 为准）

### S1.1
- `npm run check` → exit 0，约 10.4s（< 120s）；`validate:seeds` 的通配符在 sh 下正常展开
- `npm run test:api` → 仅 src/app/api/games/[id]/events/route.test.ts（1 file）
- 负向验证：src/lib/seats.ts 注入类型错误后 `npm run check` exit 2（error TS2322），已还原

### S1.2
- `npx vitest run src/lib/app-config.test.ts` → 5 passed（新增 2：APP_CONFIG_PATH 读写落盘、回落 DATABASE_URL source=env）
- `npx vitest run` → 55 files / 389 passed
- `npm run check` → exit 0
- `.env.example` 追加 APP_CONFIG_PATH 注释说明

### S1.3
- `npx --yes yaml-lint .github/workflows/ci.yml` → successful
- check job 线上绿：https://github.com/ksws00684315/jubensha/actions/runs/36254901201（39s < 10min）
- 首次推送（36254733171）暴露 repetition.test.ts 用例在 CI 超时（即 FIND-01），放宽该用例超时至 20s 后绿
- ci-probe/lint-fail：CI failure（run 36255001939）→ `git push origin --delete ci-probe/lint-fail` 成功

### S1.4
- `npm run hooks:install` → `git config core.hooksPath` = scripts/git-hooks
- 制造 lint 错误后 `git commit` 被拒（ESLint --max-warnings=0 失败），耗时 14.5s < 60s
- 未安装者不受影响：钩子只经 core.hooksPath 生效，默认 hooksPath 不变

## 验收证据（续）
### S2.5 L4 实机环境与脚本
执行环境：pg-test 容器（jubensha-pg-test，宿主 5433）+ 隔离实例。因 :3100 被一个来历不明的遗留 `next start` 占用（pid 60062，12:15:03 启动，非本会话所起，未触碰），本轮全部实机跑在 **:3110 / :3120**（`up.mjs` 的端口回退，见 DEV-04）。

- `npm run check` → exit 0（详见「最终门禁」行）
- **R1 连续 3 次**（每轮 `e2e:up` → `e2e:smoke` → `e2e:down`，全新库）：
  - ROUND 1 `up=0 smoke=0 elapsed=61s action_failed=0 ENDED=1`
  - ROUND 2 `up=0 smoke=0 elapsed=62s action_failed=0 ENDED=1`
  - ROUND 3 `up=0 smoke=0 elapsed=61s action_failed=0 ENDED=1`
  - 每次 < 15 分钟（实测 ~61s，远低于阈值）；`voteResult` 非空（例：`{"caught":true,"counts":{"1":2,"3":3},"culpritSeat":3}`）；`grep -c '!! action failed'` = 0（修复前的脚本每轮 4 条非法动作，见 DEV-04 第 4 条）
  - 另有一次修复后的验证轮同样全绿，合计 4 次连续通过
- **R2 鉴权负向**（`scripts/e2e/auth.mjs`，3 轮均过）：`错 token action → 403`、`观战流只见公开事件 ✓，座位流可见私有 ✓`、`无口令 /api/providers → 401`、`伪造 Host providers → 401`
- **R3 SSE 断线续传**（`scripts/e2e/sse-resume.mjs`，3 轮均过）：`全量回放 … lastSeq=103` → 断线期产生 3 条 → `重连补传 3 条`、`seq 严格递增 ✓ 与 DB 全集一致（不重不漏）✓`
- **R4 进程重启恢复**（`scripts/e2e/restart-resume.mjs`，步骤见 `scripts/e2e/README.md`）：
  - 停等点 `已停等并记录 DISCUSSION r1`（真人回合，引擎停等）
  - `e2e:down --keep-db`（`实例 pid=4542 已停止` + `保留 jubensha_e2e 库`）→ `e2e:up --keep-db`（`实例已启动 pid=5249`）
  - `重启后首读核对一致：DISCUSSION r1 turn=0` → `SEARCH r2` → `DISCUSSION r2` → `VOTE r1` → `ENDED`
  - `恢复后推进到 ENDED ✓ voteResult: {"caught":true,"counts":{"3":4,"4":1},"culpritSeat":3}`、`R4 PASSED`
  - `grep -cE 'unhandled|UnhandledPromiseRejection|FATAL' .e2e/instance.log` → **0**
- **用户进程无影响**：`pm2 describe jubensha` restarts 执行前 25 → 执行后 25（:3000 未被触碰）
- **down 清理**：`SELECT count(*) FROM pg_database WHERE datname='jubensha_e2e'` → `0`（`--keep-db` 时除外，R4 第 ②③ 步即为该路径）
- `SEED_BASE=http://127.0.0.1:<e2e 端口> SEED_ADMIN_TOKEN=<口令> node scripts/import-seeds.mjs` → `导入 29，跳过 2，失败 0`，exit 0（`/api/scripts` 返回 32 本）
- L3 连带复跑：`DATABASE_URL=…jubensha_test npm run test:int` → 3 files / 10 passed，exit 0
- 最终门禁：`npm run check` → exit 0，Test Files 78 / Tests 558 passed | 2 expected fail

### S2.6 R9 浏览器实机首轮
驱动 `scripts/e2e/browser.mjs`（本机 Chrome headless=new + CDP，见 DEV-06），动作清单 `scripts/e2e/plans/r9-d{1,2,3,4a,4b,5}-*.json`，目标为 S2.5 起的隔离实例 **:3120**（`npm run e2e:up` 的端口回退）。桌面与移动各跑一遍同一套 6 个清单：**每遍 171 步、0 失败**，共 12 次运行全部 exit 0；驱动内 `elapsedMs` 合计桌面 60.2s、移动 57.6s（整条链墙钟约 4.5 分钟）：

| 清单 | plan | 桌面 1280×800 | 移动 375×812 |
|---|---|---|---|
| 1 静态 5 页 + 404 | `r9-d1-static` | 31 步 0 失败，error 1（故意的 `/no-such-page` 404），异常 0 | 31 步 0 失败，error 1（同上），异常 0 |
| 2 `/settings` 管理门 + 掩码 | `r9-d2-settings` | 25 步 0 失败 | 25 步 0 失败 |
| 3 建房→房间码→另开标签入座→开局→`/play` | `r9-d3-create-room` | 36 步 0 失败 | 36 步 0 失败 |
| 4 对局页全流程 | `r9-d4a` + `r9-d4b` | 32 + 18 步 0 失败 | 32 + 18 步 0 失败 |
| 5 刷新后身份/事件/阶段 | `r9-d5-identity-spectator` | 29 步 0 失败 | 29 步 0 失败 |
| 6 无痕上下文无私有卡与私聊 | 同上（后半） | 含在 29 步内 | 含在 29 步内 |
| 7 截图对比 | — | 首轮为基线，无上一阶段同名截图可比 | 同左 |

- 命令：`zsh .e2e/plans/chain-final.sh`（每遍先 `node scripts/e2e/browser.mjs --shutdown` 清 profile，再按 d1→d2→d3→d4a→d5→d4b 顺序，桌面 `--shot-prefix=d`、移动 `--width=375 --height=812 --mobile --shot-prefix=m`）。退出码序列：`EXIT_{d,m}_{D1,D2,D3,D4A,D5,D4B}=0` 共 12 个。
- 截图：`.e2e/screens/S2.6/` 共 **64 张 PNG（d01–d31a 桌面 32 张、m01–m31a 移动 32 张）**，≥ 20 张达标；目录 gitignore，不入库。
- 控制台 error 基线：整遍 12 次运行合计 **2 条**，且都是清单第 1 项故意访问 `/no-such-page` 产生的 `Failed to load resource: 404 @ http://127.0.0.1:3120/no-such-page`；其余 11 次运行 0 条。**未捕获异常 0 条**；`grep -c . .e2e/screens/console-errors.jsonl` 的 59 行含开发期调试运行，正式基线以上述 2 条为准（计划 §3.5「控制台 0 条 error」中的 404 一条按「故意负向用例」豁免，其余为 0）。
- 无横向滚动：每个视口 11 条断言、两遍合计 **22 条全过**（静态 5 页 + READING + SEARCH/DISCUSSION + VOTE + 结算 + 刷新后对局页 + 观众页）；另有 26 个 `layout()` 样本，`scrollWidth > clientWidth` 全为 false，移动 375 视口下 `scrollW=375=clientW`。
- 第 2 项细节：独立上下文首访显示 `解锁管理面` 口令门（`lockedText` 采集），输入 e2e 口令后卡片消失、出现「AI 接入 / 模型绑定 / 用量统计」；新增 provider 的 apiKey 在列表里渲染为 `http://127.0.0.1:1/v1 · ••••••••abcd`，断言 `body.innerText` 含掩码且不含 `sk-e2e-demo-0000` 明文 → 两侧视口均过。
- 第 3 项细节：`座位 1=human、2–5=ai`（`seatKinds=["human","ai","ai","ai","ai"]`），房间码取自 URL `/rooms/{code}`（桌面 `WK63G`、移动 `JR4FP`，格式断言 `/^[A-Z0-9]{4,10}$/i`），第二标签（独立上下文）填昵称入座→房主开局→房主跳 `/play/[id]` 显示观众视角、访客点「进入对局」后进 READING。
- 第 4 项细节（真人座位 seat 0，两局独立验证）：
  - READING「我已读完剧本」→ SELF_INTRO 输入框发言进 ChatFeed → SEARCH 选地点 → DISCUSSION 提问（`select[aria-label="选择提问对象"]` + 公开质询表单）→ VOTE 指认 + 引用公开材料 → REVEAL/ENDED 结算卡（`真凶「苏晚」逃脱`、`你的投票 未命中 有效证据 1 条 表现分 10/100`）。
  - 落库侧证（`zsh scripts/e2e/db-proof.sh <gameId>`，只读 psql 查询；当时以同名临时脚本执行，现收进 scripts/e2e/）：
    - 桌面局 `cmujgkpif00aes83piruui3nw`：`choose|seq581|r1|书房`、`choose|seq614|r2|门廊雪地`；`seq594 system|seat:0|你决定私藏线索【遗体初验与胃内容物试验】` → **私藏分支**成立，`state.heldClues."0"=["tea_autopsy","footprint"]`，且两卡最终 `clueStates.*.isPublic=true`（第 2 轮结束由主持公开）；`vote|seat0->1` + `voteEvent seq657 evidenceIds=["teacup"]` → 引证据投票成立；`state|ENDED|ended|{"caught":false,"counts":{"0":2,"1":1,"3":1,"4":1},"culpritSeat":3}`。
    - 移动局 `cmujgn2xn00bus83py3hj6j9i`：`choose|seq676|r1|书房`；`seq691 clue|public|{"clueId":"tea_autopsy","publicBy":0}` → **当场公开分支**成立；`seq721 seat:0|你决定私藏线索【雪地脚印】` → 同一局内两个分支都验到；`vote|seat0->1`、`state|ENDED|ended|{"caught":false,"counts":{"1":3,"2":1,"3":1},"culpritSeat":3}`。
  - 决策窗并非每卡都有：`policy=auto_public` 的线索（如【参茶残液】）发牌即 `system|seat:0|…该线索为公开线索，已向全场公示。`，不出现公开/私藏按钮 —— 属既有设计，清单第 4 项的按钮步骤因此用 `clickIf`，无窗口时记 skip；分支证据以上述 DB 事件为准。
- 第 5 项细节：刷新前后 `bubbles` 桌面 32→32、移动 31→31，`phase` 文本一致（`搜证 · 第 2 轮 ✓ 读本 ✓ 自我介绍`），`privateCardShown=true`（我的剧本页签含「你的秘密」），`lsKeys=1`（座位凭证留在 localStorage）→ 刷新不产生渲染重复、身份保持。同屏出现的 5 组同文案气泡经核对是 **12 条独立 `system|public` 事件（4 种文案）** 的降级提示，不是渲染重复 → 见 FIND-05。
- 第 6 项细节（独立 browser context = 无痕等价）：只带房间码打开 `/rooms/{code}` → 只有「回到本局」与「请使用原设备凭证恢复」提示，`localStorageKeys=0`，无「你的秘密」；直连 `/play/{gameId}` → 出现「观众身份观看」，无「你的行动」面板、无线索（页签内 `还没有获得任何线索`）、正文不含「私聊」。桌面 `spectatorView.bubbles=20`、移动 21（仅公开事件）。
- 凭证外泄审计：驱动记录到 `tokenQueryRequests`，两遍各 1 条（d3 与 d5 的玩家标签）：`/api/games/{id}/events?seat=0&token=…`（报告里已掩码）。这是清单第 6 项/?token= 审计的基线值 → 见 FIND-04，由 S3.5 关闭。页面 URL、`document.body` 与 `localStorage` 均无 token 明文（`feedHealth.tokenInUrl=false`、`sseHasToken=false`）。
- 收尾：`npm run e2e:down` 后 `SELECT count(*) FROM pg_database WHERE datname='jubensha_e2e'` → 0；`node scripts/e2e/browser.mjs --shutdown` 清 profile；pm2 `jubensha`（:3000）restarts 未变。

### S3.1 开房授权策略
落点：新增 `src/lib/room-policy.ts`（64 行，`roomCreatePolicy()` :12 / `requireRoomCreateAuth()` :34），接入 `src/app/api/rooms/route.ts:41`（POST 建房）与 `src/app/api/rooms/[code]/route.ts:82`（PATCH 改座）；文档 `.env.example`、README 新增小节「谁能开「含 AI 座位」的房间」；实机脚本与清单见 `dfefd64`。判据只有一条：**结果座位里是否含 `kind === "ai"`**（D2 的口径 —— 会消耗 LLM 额度的房才管，纯真人房一律自由）。

**三种策略逐条实测（L2 断言 → 结果）**

| 场景 | 期望 | 证据 |
|---|---|---|
| `open` × 无凭证 / 带口令 | 201 | A22 两用例 |
| 开发/测试默认 | `open`（不带任何凭证 201） | A22 |
| 生产默认（`NODE_ENV=production`） | `admin` | A22/A24 各 1 用例 + 实机（见下） |
| `admin` × 管理员口令 | 201 | A22/A24 |
| `admin` × 无凭证 | 403「创建含 AI 座位的房间需要管理员身份」，且 `db.room.create` 未被调用 | A22（文案逐字断言） |
| `admin` × 纯真人房 | 201 | A22/A24 |
| `invite` × 正确 / 错误 / 缺字段 | 201 / 403「邀请码不正确」 / 403 | A22/A24（`safeEqualString` 常量时间比较） |
| `invite` × 未配置 `ROOM_INVITE_CODE` | 403（fail closed，不放行） | A22/A24 |
| `ROOM_CREATE_POLICY` 取值无法识别 | 回落该环境默认值（生产 = admin）+ 一条 warn | A22 |
| `admin` 且漏配 `ADMIN_TOKEN` | 403「服务未正确配置管理员口令，暂时无法创建含 AI 座位的房间」，不是 500 | A22（见 DEV-08 第 2 条） |
| 检查顺序 | 未授权时 `db.script.findFirst` 不被调用（不能靠 404/400 差异探测剧本 id 与 zod 细节） | A22 |
| PATCH 改出 AI 座 | 与建房同检查；房主 token 校验优先（403「只有房主可以改座位」），且 `$transaction` 未被调用 | A24 |

用例数：A22 新增 14、A24 新增 9（共 23 ≥ 计划要求 10），两文件从 8/8 增至 21/17。原 `admin 策略待 S3.1 实现` 的弱断言 `expect([201,403]).toContain(...)` 收敛为 `expect(res.status).toBe(201)`（管理员路径），是收紧不是弱化。

**门禁**
- `npm run check` → exit 0：Test Files 78 / Tests 581 passed | 2 expected fail（6.0s）；tsc 0 / eslint 0 warning / seeds 校验 exit 0。
- `npm run test:api` → 23 files / 188 passed | 2 expected fail（1.4s）。
- `DATABASE_URL=…jubensha_test npm run test:int` → 3 files / 10 passed（含 `src/app/api/rooms.int.test.ts` 4 条，真库路径未受策略影响：测试环境默认 `open`）。

**实机（e2e 实例 :3120，生产构建，策略按生产默认 `admin`，未做任何放宽）**
- **R1** PASSED：`ENDED ✓ voteResult: {"caught":true,"counts":{"1":1,"2":1,"3":2,"4":1},"culpritSeat":3}`；`grep -c '!! action failed'` → 0。建房请求带 `x-admin-token` 后为 `room U7UA9 / game cmujhz90y000as8g0aenzv38b`（`/tmp/e2e-smoke-s31.log`，会话临时）。
- **R2** PASSED，新增两条判据：`无口令建 AI 房 → 403`（文案逐字核对）+ `无口令建纯真人房 → 201`；原有 4 条（错 token 403 / 观战流仅公开 / 无口令 providers 401 / 伪造 Host 401）不变。
- **R3** PASSED：`全量回放 1 条，lastSeq=97` → `重连补传 3 条` → `seq 严格递增 ✓ 与 DB 全集一致（不重不漏）✓`。
- **R4** PASSED：停等 `已停等并记录 DISCUSSION r1` → `e2e:down --keep-db` → `e2e:up --keep-db` → `重启后首读核对一致：DISCUSSION r1 turn=0` → … → `恢复后推进到 ENDED ✓ voteResult: {"caught":true,"counts":{"1":1,"3":4},"culpritSeat":3}`；重启后 `.e2e/instance.log`（420 行）异常计数 `grep -cE 'unhandled|UnhandledPromiseRejection|FATAL'` → **0**。
- **R9 续跑链**（建房 → 搜证/决策 → 讨论/投票/结算 → 刷新与观众，桌面 1280×800）：`d3 36 + d4a 32 + d5 29 + d4b 18 = 115 步，0 失败、控制台 error 0、未捕获异常 0`；驱动内耗时 8.1/22.8/7.1/10.6s。`tokenQueryRequests` 仍是每个玩家标签 1 条（d3、d5 各 1）→ FIND-04 基线不变，由 S3.5 关闭。
- **R9 负向清单** `scripts/e2e/plans/s31-unauthorized-create-room.json`（无管理会话的独立 context）：9 步 0 失败，`waitSelector "text:创建含 AI 座位的房间需要管理员身份"` 命中 → 服务端 403 文案确实渲染在原表单上，`stillOnForm=true`、`submitEnabled=true`，横向溢出 false，耗时 2.3s；控制台 1 条 error 即该故意的 403 资源日志（`.e2e/screens/S3.1/`）。
- **UI 侧零改动**（计划把 `src/app/rooms/new/page.tsx` 列为涉及范围）：`src/lib/client.ts:14` 已把 `data.error` 抛给调用方，`src/app/rooms/new/page.tsx:176` 原样渲染 —— 上面的负向清单即为行为证明，因此不改代码（DEV-08 第 1 条）。
- 口令处理：`x-admin-token` 只从 `.e2e/up.json`（gitignore）读取，plan / report / 台账 / 提交信息中均无口令明文；R9 的 `adminSession` 走真实 `/api/admin/unlock` + CDP 注入会话 cookie，不如实在页面上填口令以外的后门。
- 收尾：`npm run e2e:down` 后 `pg_database` 中 `jubensha_e2e` 计数 0（只剩 `jubensha_test`）；`pm2 describe jubensha` → online、restarts **25 → 25**（:3000 未被触碰）。

### S3.2 每日 LLM token 预算熔断
落点：新增 `src/core/llm/budget.ts`（83 行）——`BudgetExceededError` :4、`dailyTokenBudget()` :15、`startOfLocalDay()` :23、`usedToday()` :45（60s 缓存 + 并发共用一次查询）、`usedTokensToday()` :71（看板用的免缓存读数）、`assertWithinBudget()` :76；三个入口的第一行接入：`chat` `src/core/llm/client.ts:357`、`chatStream` `:456`、`embedTexts` `:513`（`.env.example` 新增 `LLM_DAILY_TOKEN_BUDGET` 说明块）；看板 `src/app/api/usage/route.ts:56`（响应加 `budget` 字段）+ `src/app/settings/page.tsx:680`（「今日用量」卡片）。

**口径与逐条实测（L1 断言 → 结果，13 用例）**

| 场景 | 期望 | 证据 |
|---|---|---|
| `LLM_DAILY_TOKEN_BUDGET` = 未设置 / `""` / `0` / `abc` / `-5` / 空白 | 视为关闭，**一次库都不查**（`usageLog.aggregate` 调用数 0） | L1 用例 1 |
| 关闭时 `chat` 的库调用 | 与改动前逐字一致：只有 1 次绑定查询 + 1 条用量日志，`aggregate` 0 次 | L1 用例 8（计划验收「查询数相同」的 mock 计数断言） |
| 60s 内连续调用 | 只查库 1 次；跨过 60s 才第 2 次（fake timers：59s→1、+2s→2） | L1 用例 2 |
| 当日合计 999 / 预算 1000 | 放行 / **≥ 才拦**（1000 抛） | L1 用例 3 |
| 求和窗口 | `where.createdAt.gte` 恰为服务器本地时区当天 00:00 | L1 用例 4 |
| 跨过次日 00:00 | 缓存按天失效，重新按新一天求和 | L1 用例 5 |
| 并发 5 次调用 | 共用同一次查询（不放大库压力） | L1 用例 6 |
| 求和本身失败（库抖动） | 放行 + 一条 `warn`，并把该结果缓存 60s（守卫不新增失败面） | L1 用例 7 |
| 超预算 × `chat` | 抛 `BudgetExceededError`，模型请求 0 次、绑定查询 0 次、用量日志 0 条 | L1 用例 9 |
| 超预算 × `chatStream` | 在**首个 chunk 之前**抛（不是流中断） | L1 用例 10 |
| 超预算 × `embedTexts` | 返回 `null` → 检索层整体停用，不把异常抛进发言主流程（与「未绑定」同契约，`client.ts:509`） | L1 用例 11 |
| 错误文案 | 含 `used/budget` 两个数字，**不含** URL / apiKey / Bearer / provider / `model=`（该文案会经 `turns.ts:152` 广播进公开事件流，观众可见） | L1 用例 12 |
| 运营日志 | `[llm] budget_exceeded purpose=dm used=150 budget=100`（S6.1 之前先用 `console.warn`，计划明文要求） | L1 用例 13 |

**L3（I11，真库 `jubensha_test`，不 mock `@/core/llm/client`，3 用例 / 15.2s）**
- 真实 `usage_logs` 当日合计 1200 ≥ 预算 1000 → `chat` 拒绝为 `BudgetExceededError`；**fetch 探针 0 次调用**（探针替换 `globalThis.fetch` 为抛错桩，任何出网请求都会立刻暴露）。
- 昨天 9999 + 今天 10 未超 → `chat` 抛的是原有的「尚未绑定模型」，证明求和**只按本地当天**，且熔断未抢在既有降级之前。
- 超预算全程对局（预算 500、当日 501，真人 1 + AI 补位）：**走到 `ENDED`**、`voteResult` 非空、阶段轨迹 `READING → SELF_INTRO → SEARCH → DISCUSSION → VOTE → ENDED` 逐个走完（不是直接落到结束），AI 发言降级为公开提示且文案含「预算已用尽」，真人正式发言 ≥ 2 条，全程 10.7s、模型请求 0 次。这一条就是计划验收的「R1 式对局在超预算时仍能走到 ENDED」。

**看板一致性**：`GET /api/usage` 加 `budget: { daily, usedToday, dayStart }`，与熔断共用 `startOfLocalDay()` 一个口径；L2 用例断言该读数**不走 60s 缓存**（`aggregate` 恰好再查一次），否则运营看到的百分比会比实际熔断点滞后最多一分钟。`settings` 页新增首卡「今日用量（服务器本地时区）」，未设预算时显示「/ 未设每日预算」并提示如何开启。UI 其余部分零改动。

**门禁**
- `npm run check` → exit 0：Test Files 79 / Tests 595 passed | 2 expected fail（5.9s）；tsc 0 / eslint 0 warning / seeds 校验 exit 0。
- `npm run test:api` → 23 files / 189 passed | 2 expected fail（2.0s）。
- `DATABASE_URL=…jubensha_test npm run test:int` → 4 files / 13 passed（15.2s，本轮 35 条 `budget_exceeded` warn 全部来自用例内主动熔断）。
- 本步不需要实机：S3.2 的验收判据（三入口拦截、关闭时查询数、超预算对局走到 ENDED）全部在 L1/L3 覆盖，实机 R1–R4/R9 由 P3 阶段验收统一跑。

**过程中发现的对外花钱通道（FIND-07）**：`@prisma/client` 会把仓库根 `.env` 自动读进 `process.env`，本机 `.env` 里的 `JEV_SHADOW=1` / `JEV_FALLBACK=1` 因此让 L3 对局与 :3120 实机实例在每个 AI 座位决策时向外部端点发真付费 HTTP 请求 —— 这条通道不经 `chat`/`chatStream`，**本步的预算熔断管不到**。证据：I11 首跑 fetch 探针被调用 12 次（同一配置下熔断已生效、模型请求为 0）。已在 `src/test/int.ts:14` 与 `scripts/e2e/up.mjs:95` 删除 `JEV_*` 键（DEV-10），探针保留为常驻守卫；通道本身另计 FIND-07。

**收尾**：未连接、未改动 `jubensha`（:3000）与任何真库；`.env` / `local.*.json` 只读取过变量名，未读取或记录任何密钥值；本轮含密钥明文的一次失败输出日志已删除。

### S3.3 凭证比较统一为常量时间
落点：新增 `src/lib/credentials.ts`（35 行）—— `verifyToken()` :9 为原语（任一侧空即不匹配，非空走 `admin.ts:43` 的 `safeEqualString` → `node:crypto.timingSafeEqual` + 长度校验），`verifySeatToken()` :17、`verifyDmToken()` :30、`verifyHostToken()` :34 是按凭证类型的包装；单一实现，不复制粘贴第二份常量时间比较。

**逐点替换（调用点 → 语义等价性）**

| 位置 | 原来的判断 | 现在 |
|---|---|---|
| `games/[id]/actions/route.ts:41` | `!seatRow \|\| !seatRow.token \|\| seatRow.token !== token` | `verifySeatToken(seats, seatIndex, token)` |
| `games/[id]/route.ts:38` | 同上（失败降级为观战） | 同上，另含 BUG-01 的 header 优先修正 |
| `games/[id]/events/route.ts:56` | `!seatRow?.token \|\| seatRow.token !== token` | `verifySeatToken` |
| `games/[id]/events/route.ts:61` | `!!dmToken && dmToken === q("dmtoken")` | `humanDm &&` 保留在调用点，比对交给 `verifyDmToken` |
| `games/[id]/events/route.ts:138`（心跳重验） | `(seats.find(...)?.token ?? "") === (q("token") ?? "")` | `verifySeatToken`；原写法在「座位 token 被清空且请求侧也没带」时会误判有效，但该状态不可达（初验要求 stored 非空才能拿到 seatIndex），改动后两种路径判定一致 |
| `games/[id]/events/route.ts:139`（心跳重验 DM） | `humanDm && dmToken === q(...)` | `humanDm && verifyDmToken` |
| `games/[id]/dm-actions/route.ts:29,51` | `!humanDm \|\| !dmToken \|\| dmToken !== token` | `!humanDm \|\| !verifyDmToken` |
| `tts/route.ts:35,36` | `!!token && seats.some(s => … s.token === token)`、`dmToken === dmToken` | `verifySeatToken`（index 为 undefined 时自然不通过，故去掉外层 `seat !== undefined`）、`verifyDmToken` |
| `rooms/[code]/route.ts:29,32,33`（GET 三种授权） | `Boolean(room.X && (q ?? header) === room.X)`、`seats.some(…)` | `verifyHostToken` / `verifySeatToken` / `verifyDmToken`（观战授权路径仍**不**看 `humanDm`，与原实现一致） |
| `rooms/[code]/route.ts:79`、`rooms/[code]/start/route.ts:24` | `!room.hostToken \|\| room.hostToken !== body.hostToken` | `!verifyHostToken(room, body.hostToken)` |
| `join.ts:33,34,56,57`（恢复/认领判定） | `Boolean(presented && stored && presented === stored)`、`named[0].token === presented` | `verifyToken`；「两侧都得非空」原本由前置守卫表达，现在由原语承担 |

用例数：L1 新增 12（`credentials.test.ts`，含计划要求的 null / 空串 / 长度不同 / 正确四种，外加「双侧皆空也不算匹配」「未发卡座位拒绝」「凭证不跨座位通用」「确实调用 `timingSafeEqual`」）；L2 的 A28 由 `it.fails` 翻正为 `it`，另补 1 条（header 缺失时 query 仍可用；header 在场且错时 query 不能翻案）。**没有删除或放宽任何既有用例**：`join.test.ts` 的 18 条断言原样保留，只有 `gameEventsUrl` 的 import 路径改到新模块（DEV-11 第 1 条）。

**验收 grep**：`grep -rnE 'token\s*!==|!==\s*.*[Tt]oken' src/app/api src/lib/join.ts` → **输出为空**（exit 1）。为让这条 grep 字面成立，另做了两处等价重写（DEV-11 第 2 条）：`rooms/[code]/route.ts` 的座位投影 `s.kind !== "human" ? { token: null } : {}` → `s.kind === "human" ? {} : { token: null }`；`bindings/route.ts:78` 的 `d.maxTokens !== undefined ? {…} : {}` → `d.maxTokens === undefined ? {} : {…}`。两者与凭证无关，仅因正则把 `maxTokens` / `{ token: null }` 也算作命中。

**门禁**
- `npm run check` → exit 0：Test Files 80 / Tests 609 passed | 1 expected fail（4.0s；expected fail 只剩 BUG-03，BUG-01 已翻正）。
- `npm run test:api` → 23 files / 191 passed | 1 expected fail（1.0s）。
- `DATABASE_URL=…jubensha_test npm run test:int` → 4 files / 13 passed（14.8s）。
- `npx next build` → exit 0（这一步的必要性见 DEV-11 第 1 条：先失败过一次，客户端链不能引服务端凭证模块）。

**实机（e2e 实例 :3120，生产构建；凭证路径全覆盖，故在阶段验收之前先跑一轮）**
- **R1** PASSED：`ENDED ✓ voteResult: {"caught":false,"counts":{"1":2,"3":1,"4":2},"tiedSeats":[1,4],"culpritSeat":3}`，`!! action failed` 计数 0（真人 token 走 body、SSE 走 query 的整局流程未受影响）。
- **R2** PASSED：`错 token action → 403`、`DM force_ready → 200`、`观战流只见公开事件 ✓，座位流可见私有 ✓`、`无口令建 AI 房 → 403`、`无口令建纯真人房 → 201`、`无口令 /api/providers → 401`、`伪造 Host providers → 401` —— 座位 / DM / 房主三类凭证的正负向都在真 HTTP 路径上验证过。
- **R3** PASSED：`全量回放 1 条，lastSeq=97` → `重连补传 3 条` → `seq 严格递增 ✓ 与 DB 全集一致（不重不漏）✓`（SSE 建连与心跳重验路径）。
- 实例日志 `.e2e/instance.log`（434 行）异常计数 `grep -cE 'unhandled|UnhandledPromiseRejection|FATAL'` → **0**。
- 收尾：`npm run e2e:down` → `jubensha_e2e` 计数 0；`pm2 describe jubensha` → online、restarts **25 → 25**（:3000 未被触碰）。R4（进程重启恢复）与 R9（浏览器走查）按计划留给 S3.4 的全量重跑与 P3 阶段验收。

### S3.4 CSP 从 report-only 转为强制执行

**落点**
- `next.config.ts:9` `isDev`；`:16-29` `cspHeaderValue()` —— `:17` 只在开发分支把 `'unsafe-eval'` 放进 `script-src`，`:28` 按分支选 `Content-Security-Policy-Report-Only` / `Content-Security-Policy`；`:36` 仍挂在 `/:path*` 上。除这两处外，8 条指令逐字照搬 S2.6 观察期的值（`default-src`/`style-src`/`img-src`/`media-src`/`connect-src`/`font-src`/`frame-ancestors` 未动）。
- 依据（本仓库自带的 Next 文档，非记忆）：`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md:42` —— `'unsafe-eval'` 只因 React 在开发期用 `eval` 还原服务端错误栈，生产不需要。
- `scripts/e2e/browser.mjs:591` 新增 `cspViolations`（按 `Content Security Policy` / `Refused to load|execute|apply|display|connect|install|bypass` 从 console error 里单独筛出），写进报告 JSON（`:601`）、`console-errors.jsonl`（`:605`）与完成日志（`:607`）。没有这个计数，「CSP 违规 = 0」只能靠人肉读 12 份报告的 error 文本。

**验收标准逐条**
1. *强制头且不含 unsafe-eval*：`curl -sI http://127.0.0.1:3120/ | grep -i content-security-policy` →
   `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'self'`。
   头名是 `Content-Security-Policy`（非 `-Report-Only`），全文无 `unsafe-eval`。计划写的是 :3100，本机 :3100 被遗留进程占用，按 DEV-04 的端口回退落在 :3120，判据不变。
2. *开发环境仍 report-only*：不启 dev 服务（会与 :3120 抢同一份 `.next`），改为直接对配置文件求值两分支：`node --experimental-strip-types .e2e/csp-probe.mjs` →
   `development: Content-Security-Policy-Report-Only | unsafe-eval=true`
   `production: Content-Security-Policy | unsafe-eval=false`
3. *R9 通过 + 控制台 CSP 违规 = 0*（生产构建、全新实例 pid=13502、无 Jev 出网）：桌面 1280×800 与移动 375×812 各 6 份清单，**12/12 exit 0**，每遍 171 步、合计 342 步 0 失败，驱动内耗时合计 113.2s（桌面 57.2s / 移动 56.0s）。

| 运行 | 步数 | 失败 | 控制台 error | **CSP 违规** | 未捕获异常 | token query |
|---|---|---|---|---|---|---|
| d1–d6（桌面） | 31/25/36/32/29/18 | 0 | 1/0/0/0/0/0 | **0**（全部 12 次） | 0 | 0/0/1/0/1/0 |
| m1–m6（移动） | 31/25/36/32/29/18 | 0 | 1/0/0/0/0/0 | **0**（全部 12 次） | 0 | 0/0/1/0/1/0 |

   合计：控制台 error **2** 条，都是清单第 1 项故意访问 `/no-such-page` 产生的 404（S2.6 已按「故意负向用例」豁免）；**CSP 违规 0**、未捕获异常 0。生产强制头下没有任何合法资源被误伤：脚本、内联样式、`blob:` 音频（TTS）、`data:` 字体与图片、SSE `connect-src 'self'` 全部照常工作，这一点由「12 次运行 0 失败 + 走到 ENDED 的整局」共同证明，而不是靠头文本推断。
4. 布局回归：13 个采样点 `horizontalOverflow` 全为 false（报告 `layout` 字段），与 S2.6 基线一致。

**门禁**
- `npm run check` → exit 0：Test Files 80 / Tests 609 passed | 1 expected fail（3.6s；expected fail 仍是 BUG-03）。
- `npm run db:test:up` + `DATABASE_URL=…jubensha_test npm run test:int` → 4 files / 13 passed（14.9s）。
- 本步无新增 vitest 用例（改动面是 HTTP 头与实机基建），判据由 curl 实读 + 配置求值 + R9 12 次运行承担。

**过程中修掉的两处基建缺陷（都不是 CSP 问题，但挡住了「R9 通过」这条判据）**
1. **DEV-10 的 e2e 半边从来无效**：`up.mjs` 删的是父进程 env，`next start` 子进程首次实例化 Prisma Client 时自己读仓库根 `.env`，把 `JEV_SHADOW` / `JEV_FALLBACK` / `JEV_API_KEY` 灌回来。证据：`.e2e/instance.log` 前 444 行含 **240 条 `[jev]` 出网记账**（覆盖当天 30 局、S3.1–S3.4 的全部 e2e 运行），逐条 `≈$…` 求和 **≈$0.0100**。改为显式 `ENV.JEV_SHADOW="0"` / `ENV.JEV_FALLBACK="0"`（dotenv 不覆盖已存在的键）并重启实例后，第 445 行起 `[jev]` 计数 **0**、本轮 R9 全程零出网。L3 那半边（`src/test/int.ts:14`）确实有效——I11 的 fetch 探针断言「0 次出网」在 S3.4 重跑里仍绿，两者机制差别见 DEV-10 第 2 条的更正。
2. **R9 清单的搜证决策步是空操作**：`r9-d4a-play-early.json` 写的是 `"clickIf": "{decisionFirst}"`，替换后是裸串 `暂时私藏`，被 `document.querySelector` 当成**标签选择器**（合法 CSS，永不命中）→ 记 `skip`、判 `ok`。S2.6 首轮真人恰好抽到公开线索（本就没有决策窗），缺陷没暴露；本轮抽到【遗体初验与胃内容物试验】（需当场公开/私藏）后：SEARCH 第 1 轮停等 **5 分 26 秒**（08:52:08 → 08:57:34，`game_events` seq 49→63），由后续 `d4b` 的 until 循环补点才推进，于是 d4a 的「公开质询」步骤 300s 超时失败。第二遍重跑桌面与移动**同时**失败（`EXIT_D_D4A=1`、`EXIT_M_D4A=1`），确认是确定性缺陷不是偶发。补上 `text:` 前缀后：同一分支（真人抽到需决策线索，`pd` 前缀第 2 次运行）线索卡 09:24:43 到手、**09:24:48 由 d4a 自己记下「你决定私藏线索【遗体初验与胃内容物试验】」**并立刻进入圆桌讨论（seq 688→690），d4a 32 步 0 失败。
   顺带把 `browser.mjs` 的 `skip:` 记录改成替换后的选择器（原来打印 `{decisionFirst}`，看不出驱动到底找过什么）。

**发现**：真人的「线索公开/私藏」决策没有回合限时（FIND-08）——`armHumanTimeout` 覆盖读本、自我介绍、选搜证地点、圆桌发言、回答提问、投票六处，独缺这一处，所以真人不做决策可以让 SEARCH 无限停等；上面那次 5 分 26 秒就是实测读数。

**收尾**：`node scripts/e2e/browser.mjs --shutdown` 只杀本 profile 的 Chrome（11 个进程），用户日常 Chrome（pid 1960）存活未受影响；e2e 实例保留在 :3120 供 P3 阶段验收续用，`pm2 jubensha`（:3000）未触碰。
### S3.5 SSE 凭证改一次性票据

**落点**
- 新建 `src/lib/stream-tickets.ts`（58 行）：`:12` `STREAM_TICKET_TTL_MS = 60_000`；`:14` `StreamPrincipal = {kind:"seat",seat,credential} | {kind:"dm",credential}`；`:20` 进程内 `Map`（与引擎注册表、限流桶同一单实例前提）；`:29` `issueStreamTicket`（`randomBytes(16)` 十六进制、签发时顺带清扫过期项）；`:45` `consumeStreamTicket`（**先删再判**：过期/重复使用/跨局一律 `null`）；`:56` `resetStreamTickets`（A29 的 `beforeEach` 用）。票据主体存的是签发时已验证的凭证，见 DEV-13 第 4 条。
- 新建 `src/app/api/games/[id]/stream-ticket/route.ts`（53 行）：`:22` 限流 → `:32` 参数 400 → `:35` 404 → `:39` 座位（`x-seat-token` + `verifySeatToken`）→ `:45` 真人主持（`x-dm-token` + `room.humanDm` + `verifyDmToken`）→ `:50` 一律 403 `{error:"凭证校验失败"}`；`:53` `withRoute` 包装（不变式 5：500 只回固定文案）。凭证只从 header 读，绝不从 query 读。
- `src/app/api/games/[id]/events/route.ts`：`:65-95` 凭证判定改为 ticket 优先——`:71` `consumeStreamTicket`，命中则按票据主体定 `seatIndex`/视角并存凭证快照；`:83-84` 无 ticket 时走旧 query 分支；`:86-94` 校验不过降级纯观战，`:90/:94` 兼容路径各记一条 deprecation 日志（`:39` `warnLegacyCredential`，**只写视角不写凭证**）；`:172-173` 心跳重验的比对基准换成快照而非 `url.searchParams`。`visibleTo` 与事件产出路径一字未动（不变式 1/4）。
- `src/lib/game-events-url.ts:24-26`：`opts.ticket` 优先，写了 ticket 就**不再**写 `seat`/`token`/`dm`/`dmtoken`；旧分支保留（`:27-31`）。
- `src/app/play/[gameId]/_components/useGameStream.ts:140-283`：连接由自己管（原生 `EventSource` 的自动重连与一次性票据不兼容）——`:245` `connect()` 先换票再建流，`:265` 仅 403/404 降级公开流（与旧版「校验不过当观战」一致），`:273` 其他失败按 `min(1s·2^n, 15s)` 退避重试（`:152`）；`:271` 建连 URL 用 `ticket + lastSeq`；`:278-283` cleanup 里 `disposed` + 清定时器 + 关流，effect 依赖不变。
- `src/lib/rate-limit.ts:110-116`：`checkStreamTicketRateLimit`（同 IP 30/min + 全局 600/min），见 DEV-13 第 2 条。

**验收标准逐条**
1. *L2：ticket 过期、重复使用、跨局使用均被拒* —— A29 附加 6 用例（`events/route.test.ts:228-345`）逐条对上：`:257` 有效 ticket 收到本席私密（行 6/7）且**断言 URL 里没有 `token=`**、并触发引擎懒恢复；`:268` 同一张票第二次建连 → 只收到公开事件 `["6"]`；`:282` `issueStreamTicket(..., Date.now()-STREAM_TICKET_TTL_MS)` 过期票与跨局票 → 都只剩 `["6"]` 且 `db.game.findUnique` 未被调用（不唤醒引擎）；`:298` DM 票看得到他席私信（行 8），而座位票硬拼 `&dm=1&dmtoken=…` 也升不了视角；`:312` 兼容期 `?seat=&token=` 仍可用且 `console.warn` 文案含 `stream-ticket`、不含 `tok-0`；`:324` fake timers 推 20s 心跳：凭证快照未变 → 流保活，座位 token 换成 `rotated` → 一个心跳周期内收流。
2. *A37 与 A29 补充* —— 新建 `stream-ticket/route.test.ts` 8 用例（票格式 `^[0-9a-f]{32}$`、TTL、票据绑座、二次消费为 `null`、DM 票、6 种凭证不符/缺凭证/跨座用票 → 403、`humanDm:false` 不能换 DM 票、`seat:99/-1/"0"` 与 `dm:"yes"` → 400、404、同 IP 第 31 次 → 429 + `Retry-After`、响应体不含凭证明文）；A35 的 `cases[]` 加一行覆盖新处理器（21 → 22），`POST /api/games/[id]/stream-ticket` 毒化 `game.findUnique` 后仍只回固定文案。`npm run test:api` → **24 files / 206 passed + 1 expected fail**（1.2s）。
3. *前端建连 URL 不含 `token=`（R9 网络面板核对）* —— R9 全量重跑（生产构建、:3120、无 Jev 出网），桌面 1280×800 与移动 375×812 各 6 份清单，**12/12 exit 0**、每遍 171 步、合计 342 步 0 失败，驱动内合计 116.4s（桌面 60.2s / 移动 56.2s）：

| 运行 | 步数/失败 | 控制台 error | CSP 违规 | 未捕获异常 | `token=` 请求 | `ticket=` 请求 |
|---|---|---|---|---|---|---|
| td01–td06（桌面） | 31/25/36/32/29/18，失败全 0 | 1/0/0/0/0/0 | 0 | 0 | **0/0/0/0/0/0** | 0/0/**1**/0/**1**/0 |
| tm01–tm06（移动） | 31/25/36/32/29/18，失败全 0 | 1/0/0/0/0/0 | 0 | 0 | **0/0/0/0/0/0** | 0/0/**1**/0/**1**/0 |

   捕获到的建连 URL 原文（票据值按 DEV-06 的掩码规则处理）：`http://127.0.0.1:3120/api/games/cmujnqk0c…/events?ticket=‹redacted›`（桌面 d3 建连、d5 重连各 1 条；移动两局 `cmujnsx2y…` 同形）。对照 S3.4 基线：同两套清单当时是 `token=` 4 条 / `ticket=` 0 条。12 份报告 `layout.horizontalOverflow` 全为 false；error 2 条仍是第 1 项故意的 404。
4. *兼容路径仍然可用* —— 三面同证：L2 `:312` 用例（旧 query 建流仍能收到本席私密）；R3 追加段实机检查（`sse-resume.mjs`：`?seat=&token=` 建流成功 **且** 实例日志新增行里出现「使用已废弃的 query 凭证」而**不含 seatToken 明文**）；`gameEventsUrl` 的旧分支保留（`join.test.ts` 新增 1 用例锁住「给了 ticket 就不再写 seat/token」的优先级，旧 4 条用例断言原样）。
5. *L4：R3 通过* —— 原三段公开流断言逐字未改（`seq 严格递增 ✓ 与 DB 全集一致（不重不漏）✓`），追加的 ticket 段另外断言：座位票流是公开全集的**超集**且严格递增、地址不含 `token=`；主持票流可建；重复使用同一张票 → 服务端按未鉴权降级（日志出现「ticket 无效」）。`npm run e2e:smoke` 输出 `R1/R2/R3 PASSED`、exit 0。

**不变式自查**
- #5 不外泄：换票响应只有 `{ticket, expiresAt}`；两条新日志只写视角/gameId；R9 报告对 `token|dmtoken|ticket` 三类值统一掩码（`browser.mjs:241`）；R3 显式断言实例日志不含 seatToken 明文。本轮 R9 期间实例日志新增 17 行，其中**提到这两局 gameId 的行 0 条**（即没有任何降级/告警被触发）。
- #3 旧档兼容 / #4 SSE 三处一致：本步不碰 `games.state`、不碰事件类型与 `visibleTo`，只换凭证层。
- #6：本步不是「重构」标注步，行为变化就是目标本身（URL 去凭证），并用「公开流全集 ⊆ ticket 流」保证私有事件不因换票而丢。

**顺带修掉的 L3 竞态（FIND-09）**：`recovery.int.test.ts` 的 I06 在整批并发跑时 3 次里挂 2 次（`restored.events` 比内存快照多一条 `seq 4` 的「轮到你发言」系统事件）。用一次性探针（快照后 sleep 1500ms）稳定复现同一多出行后定位：该事件由引擎**定时器**写库，不在 `handleAction` 的 await 链里，落在「取快照」与 `GameEngine.load()` 回读之间。修法是在快照前先 `engine.clearTimers()`（`:77`，与同文件 `:64` 的既有做法一致），不改生产代码、不删断言、不放宽阈值。之后 `test:int` 连跑 4 次全绿（4 files / 13 过，约 15s）。探针文件已删除。

**门禁**
- `npm run check` → exit 0：Test Files 81 / Tests 625 passed | 1 expected fail（首测 4.4s，收口复跑 5.9s；expected fail 仍是 BUG-03）。
- `npm run test:api` → 24 files / 206 passed | 1 expected fail（1.2s）；`test:int` → 4 files / 13 passed；`npm run build` → exit 0。
- `npm run e2e:down && npm run e2e:up && npm run e2e:smoke` → exit 0，R1（`ENDED ✓ voteResult {"caught":false,…,"culpritSeat":3}`）/ R2 / R3 全绿；实例日志 `ERROR` 0、`Unhandled` 0、本轮 `[jev]` 0（累计仍 240，即历史值未增加）。
- R9 全量重跑 12/12 exit 0（见上表）；`node scripts/e2e/browser.mjs --shutdown` 后用户日常 Chrome 未受影响；e2e 实例 :3120 保留给 P3 阶段验收，`pm2 jubensha`（:3000）未触碰。

**过程中的自伤与更正**：`.e2e/plans/chain-s35.mjs` 第一版按**字节偏移**去切按字符读入的日志文本（`readFileSync(LOG,"utf8").slice(size)`），中文日志里这个口径会把统计整体前移，第一次跑只报「新增 1 行」。改为 `readFileSync(LOG).subarray(startedAt).toString("utf8")` 后重跑整轮 R9（上表即重跑结果），并按 gameId 单独核对「本轮两局的服务端日志行 = 0」。

### S4.3 GameState 版本化与 zod 校验

**落点**
- `src/core/engine/types.ts:29` `export const CURRENT_STATE_VERSION = 1`；`:61` 必带字段 `stateVersion: number`，注释写明「旧快照（S4.3 之前）没有这个字段，按 v0 处理」。常量放 types 而非 state-migrate 的理由写在 `:24-28`：`initialState()` 与迁移函数共用同一个值，放哪一边都会形成模块环。
- `src/core/engine/state.ts:10` `initialState()` 返回体首字段 `stateVersion: CURRENT_STATE_VERSION`；`:47` 的「状态恢复路径说明」注释改指 `migrateState()`。
- 新建 `src/core/engine/state-schema.ts`（112 行）：`:14` `PhaseSchema`（8 阶段 `z.enum`）、`:16` `SeatSchema`、`:23` `VoteRecordSchema`、`:29` `QuizResultSchema`、`:40` `ActionPlanSchema`、`:51` `GameStateSchema = z.looseObject({…})` 逐字段对照 `types.ts`、`:110` `parseGameState()`。未登记字段用 `.looseObject` 而非计划的 `.passthrough()`（DEV-14 第 1 条）；座位等数字键记录用 `z.record(z.number(), …)`（JSON 里是字符串键，v4 按 key schema 归一，实测成立）。
- 新建 `src/core/engine/state-migrate.ts`（123 行）：`:11` 文件头规则（计划「具体操作」第 6 条）；`:6` 从 types 再导出常量；`:24` `MigrateContext {now, gameId}`；`:39` `MIGRATIONS`（当前只有 v0→v1：登记版本号，不改写数据）；`:55` `ensureCurrentFields()`（原 24 条 `state.x ??=` 逐条照搬，含 `interjections` 那条「不补会变 NaN → 上限失效」的注释）；`:87` `normalizeOnLoad()`（legacy `questionId` 补法、已公示线索出队、按 `ctx.now` 清过期 `humanDeadlines`）；`:111` `migrateState(raw, ctx)`：复制 → 按版本跑迁移 → 补字段 → 清理 → `parseGameState()`。
- `src/core/engine/engine.ts:9` import、`:184` 一行调用替换原 `:183-:220` 的 38 行（25 条 `??=` + 3 段清理 + `as unknown as GameState | null` 兜底）。
- 新建 `src/core/engine/__fixtures__/state/`（7 份，逐份核实 `stateVersion` 缺席）：`v0-reading`(25 键) / `v0-search`(28) / `v0-discussion`(28) / `v0-vote`(29) / `v0-ended`(29) 由 mock 库长流程用例在对应阶段截取；`v0-live-e2e`(27) 取自改动前 :3120 实机对局的 `games.state`（计划禁止的是「用户日常库」，这里是隔离库 `jubensha_e2e`）；`v0-oldest`(17) 手工裁到只剩早期字段，并让 `pendingAnswer` 没有 `questionId`、`pendingPublish["0"]` 里留一条已公示线索。7 份的 `seats[*]` 只有 `index/kind/characterId/playerName`，快照里没有任何凭证字段（不变式 5）。

**验收标准逐条**
1. *`load()` 中不再有任何 `state.xxx ??=`* —— `awk 'NR>=170 && NR<=200' src/core/engine/engine.ts | grep -c '??='` → **0**（`load()` 现为 `:153-:197`）。文件里剩余 7 条 `??=` 在 `:140/:424/:801/:820/:822/:977/:996`，都是动作处理中的运行期补齐，不属加载兼容段，本步不动（「不顺手改进相邻代码」）。
2. *新增 L1 用例 ≥ 8 个并通过；I07 通过* —— `npx vitest run src/core/engine/state-migrate.test.ts` → **23 passed**：7 份 fixture × 2（迁移后过校验并升到最新版 / 幂等 `migrateState(migrateState(x))` 与 `migrateState(x)` 相等）+「最老格式」缺字段补默认与 legacy `questionId`（含不覆盖已有值）+ 已公示线索出队 + 过期 `humanDeadlines` 双向断言（用 fixture 内 baked 时刻的 ±1s 两侧）+ `.loose` 保留未登记字段 + 4 种结构性错误被拒（`phase:"SETTLEMENT"`、`seats:"0,1,2"`、座位缺 `kind`、`clueStates` 缺 `isPublic`）+ 高于当前版本不被降级改写 + 空快照（`null/undefined/"broken"/42`）兜底 + `initialState` 直接过校验。L3 I07（`state-migrate.int.test.ts` 2 用例，`test:int` **5 files / 15 passed**，15.4s）：把 v0 快照直接写成 `games.state` 行 → `GameEngine.load()` 升到 `CURRENT_STATE_VERSION`、`GameStateSchema.safeParse` 为真、缺的默认补齐、座位 0 发言产生新 `game_events`（对局可继续）、`persist()` 回写的 `state.stateVersion` 已是最新；第二条用「最老格式」断言 `pendingAnswer.questionId` 命中 `/^legacy:/` 且待决策队列里没有已公示线索（搜证不死锁）。
3. *R4 通过（用改动前产生的快照做恢复）* —— 分两段做实：先用**改动前**的 build 起 e2e 对局并停等在 DISCUSSION（`.e2e/s43-park.log`，`[e2e:r4] 已停等并记录 DISCUSSION r1`，gameId `cmujofzyo000as8g0zl51tsm8`，座位 token 只落在 gitignore 的 `.e2e/r4-state.json`），随后换新代码 `npm run e2e:down -- --keep-db && npm run e2e:up -- --keep-db && node scripts/e2e/restart-resume.mjs --stage=resume` → exit 0，输出 `[e2e:up] 构建产物过期，执行 npm run build`、`实例已启动 pid=18851 port=3120`、`[e2e:r4] 重启后首读核对一致：DISCUSSION r1 turn=0`、`恢复后推进到 ENDED ✓ voteResult {"caught":false,"counts":{"0":1,"1":1,"3":1,"4":2},"culpritSeat":3}`、`R4 PASSED`。落库侧现在仍可读：`select phase, state->>'stateVersion' from games where id='cmujofzyo…'` → `ENDED | 1`，即这份 v0 快照被新代码载入、跑完、按 v1 写回。同一条快照的 DISCUSSION 形态已固化成 fixture `v0-live-e2e.json`。
4. *`as unknown as GameState` 数量减少* —— **3 → 2**（消掉 `engine.ts` load 里的 `(game.state as unknown as GameState | null)`；仍存 `src/app/api/games/[id]/route.ts:45`、`scripts/build-jev-vote-set.ts:68`，两处属 S4.4/S6 范围）。同口径「非测试代码 `as unknown as`」12 → **11**；`engine.ts` 行数 1044 → **1008**。

**零漂移证明（对照副本，按计划删除）**：本步是「重构」标注步，判据是迁移结果必须与旧 `load()` 兼容段完全一致。做法：把改动前的整段逐字复制成临时对照 `src/core/engine/state-migrate-equivalence.test.ts` 的 `legacyLoadCompat(rawState, gameId, now)`，对 7 份 v0 fixture 与 4 种空快照输入做 `toEqual` → `npx vitest run src/core/engine/state-migrate-equivalence.test.ts` **8 passed**；随后按计划「本步完成后删除该对照副本」删掉它，同时删掉生成 fixtures 用的 `_gen-fixtures.test.ts`。删生成器不是收尾洁癖而是必须：它会在 `npm run check` 里重跑，用**新** `initialState`（已带 `stateVersion`）覆写 5 份生成快照，把 v0 变成 v1——8 条对照用例第一次转红正是这个原因，发现后逐个剥回 `stateVersion` 并复核 7 份仍为 v0（`v=` 全 `absent`）。

**不变式自查**
- **#3 旧档兼容（本步的主题）**：三处独立证据——L1 逐份迁移过校验、L3 I07 真库 `load()` 恢复并继续推进、R4 实机用改动前快照续跑到 ENDED（验收 3）。`ensureCurrentFields()` 对**所有**版本每次加载都跑（不只是 v0），原因见 DEV-14 第 3 条：`initialState` 本就不产出某些可选字段，旧 `load()` 对新版快照也会补，只有每次都补才等价。
- **#6 无行为漂移**：清理三段逐字照搬、默认值一一对应、`Date.now()` 改成注入的 `ctx.now`（同一时刻语义相同）；对照副本 8 用例 + R4 + I07 三面覆盖。唯一非字面等价处是 `draft.clueStates?.[id]?.isPublic` 多了一层 `?.`（DEV-14 第 5 条），后果是「缺 `isPublic` 的坏快照」由 ZodError 而不是 TypeError 拒绝——`state-migrate.test.ts:113` 把这条新行为钉成断言。
- **#5 错误不外泄**：`migrateState` 抛的 ZodError 沿 `GameEngine.load()` 上抛到路由，仍由 `withRoute` 收敛成固定 500 文案；错误内容只有字段路径与期望类型，且快照与 fixtures 里没有任何凭证字段（见落点末条），新日志 0 条。
- **#1 / #2 / #4**：未触碰 prompt 出口、前缀缓存顺序、事件类型与 `visibleTo`；迁移只读写 `games.state` 的字段形态。

**门禁**
- `npm run check` → exit 0：Test Files 82 / Tests 648 passed | 1 expected fail（3.0s；expected fail 仍是 BUG-03）。
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/jubensha_test npm run test:int` → exit 0：5 files / 15 passed（15.4s）。
- 可二分性（临时 worktree，逐个 commit 复验）：`229d2e0` → `npx tsc --noEmit` exit 0、`npx vitest run` 81 files / 625 过 + 1 expected fail，与 S3.5 收口时逐字相同（即纯重构、测试数不变）；`8084efe` → tsc exit 0、engine L1 15 files / 126 过、`test:int` 5 files / 15 过。worktree 用完已 `git worktree remove`。
- e2e：本轮只跑 R4 一段（判据所需），:3120 实例与 `jubensha_e2e` 按 P4 期间惯例保留（`--keep-db`）；`pm2 jubensha`（:3000）未重启未触碰；用户日常库未连接。R1/R2/R3 与 R9 留到 P4 阶段验收一次性全量重跑。

## 阶段验收
- **P0（补记）**：S0.1–S0.4 全 DONE；`G-std` 绿（tsc 0 / eslint 0 / vitest 387→389 / seeds 校验 exit 0）；台账与指标看板建立。
- **P1（补记）**：`npm run check` 可用且绿（10.4s）；CI `check` job 线上绿（run 36254901201，39s）；`APP_CONFIG_PATH` 生效（读写落盘 + 回落 env 两用例）；pre-commit hook 生效且不影响未安装者。
- **P2（2026-09-27，S2.1–S2.6）**：
  - `npm run check` → exit 0（12.3s），Test Files 78 / Tests 558 passed | 2 expected fail。
  - `npm run db:test:up` + `DATABASE_URL=…jubensha_test npm run test:int` → 3 files / 10 passed（I01–I04、I06 与 S2.4 的恢复点/并发用例）。
  - `G-e2e`（同一轮全新库）：`e2e:down` → `e2e:up` → `e2e:smoke` 依次 **R1 PASSED**（`ENDED ✓ voteResult: {"caught":false,"counts":{"0":2,"3":2,"4":1},"tiedSeats":[0,3],"culpritSeat":3}`，`!! action failed` 计数 0）、**R2 PASSED**（403 / 观战流无座位事件 / 无口令 401 / 伪造 Host 401）、**R3 PASSED**（断线补传、seq 递增、与 DB 全集一致）；**R4 PASSED**（停等 `DISCUSSION r1 turn=0` → `e2e:down --keep-db`（`实例 pid=145 已停止`）→ `e2e:up --keep-db` → `重启后首读核对一致：DISCUSSION r1 turn=0` → `SEARCH r2` → `DISCUSSION r2` → `VOTE r1` → `ENDED`，`恢复后推进到 ENDED ✓ voteResult: {"caught":true,"counts":{"1":1,"3":4},"culpritSeat":3}`；`grep -cE 'unhandled|UnhandledPromiseRejection|FATAL' .e2e/instance.log` → **0**，该文件含本轮 R1–R4 全部 350+ 行）。
  - 清理与无影响证明：`npm run e2e:down` → `jubensha_e2e 库已删除`，`pg_database` 计数 0；`pm2 describe jubensha` → status online、restarts **25 → 25**（:3000 未被触碰）。
  - **L2 覆盖 35/35**：`grep -oE "describe\(.A[0-9]{2}"` 去重得 A01–A35 全在；`npm run test:api` → 23 files / 165 passed + 2 expected fail（2.5s）；22 个 `route.ts`（34 个导出处理器）全部有同名 `route.test.ts`。
  - 台账「发现的缺陷」栏：BUG-01–03、FIND-01–06 完整登记（FIND-01 已关闭，其余 OPEN 并标注归属步骤）。
  - R9（S2.6）双视口基线见证据节；推送与 CI 见「推送与 CI 记录」。
- **P3（2026-09-27，S3.1–S3.5）**：
  - `npm run check` → exit 0：Test Files 81 / Tests 625 passed | 1 expected fail（BUG-03 仍 OPEN）；tsc 0 / eslint 0 warning / seeds 校验通过。
  - `npm run db:test:up` + `DATABASE_URL=…jubensha_test npm run test:int` → **4 files / 13 passed（15.2s）**，且本阶段内连跑 4 次全绿（S3.5 修掉 I06 的整批并发竞态后，见 FIND-09）。
  - `G-e2e`（同一轮全新库，:3120）：`e2e:down` → `e2e:up` → `e2e:smoke` → **R1 PASSED**（`ENDED ✓ voteResult {"caught":false,"counts":{"0":1,"2":2,"3":1,"4":1},"culpritSeat":3}`，无 `!! action failed`）、**R2 PASSED**（无口令建 AI 房 403 / 纯真人房 201 / 错 token action 403 / DM force_ready 200 / 观战流只见公开 / providers 401×2）、**R3 PASSED**（原断言不变 + ticket 段：座位票流 5 条 ⊇ 公开全集 4 条且地址无 `token=`、DM 票 5 条、重放票被服务端降级、兼容期 query 可用并记废弃告警）；随后 **R4 PASSED**（停等 `DISCUSSION r1 turn=0` → `e2e:down --keep-db`（pid=95944 已停止）→ `e2e:up --keep-db` → `重启后首读核对一致：DISCUSSION r1 turn=0` → `恢复后推进到 ENDED ✓ voteResult {"caught":false,"counts":{"1":2,"2":1,"3":1,"4":1},"culpritSeat":3}`）。整轮 18:22:09 → 18:24:18（含两次实例重启与 keep-db 续跑）。
  - **R9 在强制 CSP 下通过**：S3.4 与 S3.5 各做一轮全量重跑，两轮都是 **12/12 exit 0、每遍 171 步、合计 342 步 0 失败、CSP 违规 0、未捕获异常 0**；S3.5 这轮额外把「SSE URL 里的长期凭证」这条判据做实：`token=` 请求 **0 条**（S3.4 基线 4 条）、`ticket=` 4 条。
  - 实机副作用与不变式：实例日志 `ERROR` 0、`Unhandled` 0，`[jev]` 出网累计 **240 未增加**（DEV-10 更正后 e2e 一律无 Jev）；本轮两局 gameId 在服务端日志里 **0 行**（无降级、无废弃告警）；日志/report/台账均无 token、apiKey、口令明文（不变式 5，R9 对 `token|dmtoken|ticket` 统一掩码）。
  - 清理与无影响证明：`npm run e2e:down` → `jubensha_e2e 库已删除`，`pg_database` 里 `jubensha_e2e`/`jubensha_test` 计数 **1**（只剩测试库）；`pm2 describe jubensha` → status online、restarts **25 → 25**、unstable restarts 0，:3000 由同一 next-server（pid 59887，已运行 6 小时+）监听，本阶段未触碰。
  - **L2 覆盖 23/23 文件 / 35 个导出处理器**：`npm run test:api` → 24 files / 206 passed + 1 expected fail（1.2s）；A 编号去重得 **A01–A35 + A37 共 36 个**（A36 按计划在 S6.2 给 `/api/health`，本阶段未占用）。
  - 台账「发现的缺陷」栏：BUG-01 CLOSED（S3.3）、BUG-02/03 OPEN、FIND-01 CLOSED、FIND-02～FIND-09 登记并标注归属步骤；其中 **FIND-04（token 进 URL）由 S3.5 关闭**，FIND-07（Jev 通道在预算守卫之外）**仍 OPEN**——生产侧未收口，本阶段只保证了测试与实机不出网。
  - 偏差：DEV-08～DEV-13；其中 DEV-13 第 1 条是计划内部矛盾（步骤卡前置 vs 依赖速查），按速查执行并把 S5.1 需要的凭证快照留在连接作用域，使后续「心跳去 DB 化」不需要回退。

## 发现的缺陷
| 编号 | 发现于 | 描述 | 复现测试 | 状态 | 关闭提交 |
|---|---|---|---|---|---|
| BUG-01 | 审查 | games/[id] token 取值 query 优先，与注释相反 | A28 两用例（S3.3 由 it.fails 翻正为 it） | CLOSED（S3.3） | 9aea713 |
| BUG-02 | 审查 | resolveBinding 注释称沿 fallback 查找，实际直接抛错 | — | OPEN | |
| BUG-03 | S2.2 | tts/[hash]：缓存行在但音频文件丢失时，createReadStream 的 ENOENT 异步抛出，try/catch 接不住 → 实际 200 后流中断而非 404 | A34 it.fails | OPEN | |
| FIND-02 | S2.3 | vi.useFakeTimers 下引擎定时器链不收敛：AI ready 定时器延迟膨胀（5s 实际 ~60s）、SEARCH 阶段后台决策的互斥提交不落账。真实定时器 + 轮询路径正常。I06 已改为真实定时器 + 状态快进；完整流程由 R1 实机覆盖 | recovery.int.test.ts | OPEN（测试环境观察，非生产行为证明） | |
| FIND-03 | S2.5 | 实机 VOTE 阶段真人座位停等 8 分钟以上，未见 `HUMAN_TURN_TIMEOUT_MS`（180s）到点自动出手；当时测试脚本自身有缺陷（一直发 speak 未发 vote），不能据此判定产品缺陷。S6.3 卡局告警落地后用 `restart-resume.mjs` 复现一次 | scripts/e2e/restart-resume.mjs（待定版） | OPEN（待复现） | |
| FIND-01 | S0.4 | `repetition.test.ts`「只在尾部窗口内扫描」在 --coverage 插桩下超时失败（5392ms），非覆盖率模式通过；时间敏感用例，覆盖率门禁需容忍或后续修复 | npx vitest run --coverage | CLOSED（S1.3） | 4b71bd7 |
| FIND-04 | S2.6 | 前端 SSE 建连把座位 token 放进 URL query：`GET /api/games/{id}/events?seat=0&token=…`，会进浏览器历史与反向代理访问日志（不变式 5 的暴露面）。R9 网络捕获基线 = 每个玩家标签 1 条 | scripts/e2e/browser.mjs 的 `tokenQueryRequests`（`.e2e/screens/S2.6/S2.6-d5-{d,m}-report.json`） | CLOSED（S3.5：R9 12 次运行 `tokenQueryRequests` 合计 0、`ticketQueryRequests` 4；旧 query 仅保留一个版本并记 deprecation 日志） | |
| FIND-09 | S3.5 | L3 `I06`（引擎重启恢复）在**整批并发**跑时不确定失败 2/3 次：`restored.events` 比内存快照多一条 `seq 4`（`system / seat:0 / 轮到你发言…`）。根因不是恢复逻辑——下一回合提示是引擎**定时器**写库的，不在 `handleAction` 的 await 链里；取 `memoryEvents` 快照与 `GameEngine.load()` 回读之间存在竞态窗口。同批并发把窗口拉长，单跑不复现（用 1500ms sleep 探针可稳定复现同一多出行） | 探针已删除；常驻修法：`recovery.int.test.ts:77` 在快照前 `engine.clearTimers()`（与同文件 :64 的既有做法一致）。改后连跑 `test:int` 4 次 0 FAIL | OPEN（测试基建竞态，非生产缺陷；FIND-02 的同族——fake/真实定时器在测试环境的收敛问题） | |
| FIND-05 | S2.6 | 无模型局 ChatFeed 里「（AI 玩家「X」思考时遇到问题：用途槽位 "player" 尚未绑定模型…）」这类降级提示按座位×回合重复记录为公开事件：一局 5 人出现 12 条事件、只有 4 种文案，同屏 5 组重复行，观众也能看到。事件不重复（渲染无 bug），是引擎侧提示未去重 | R9 `r9-d5` 的 `identityBefore/After.bubbles vs uniqueTexts` + `psql … group by type,visibility`（台账 S2.6 证据节） | OPEN（建议 S7.3 关闭：同类 notice 按回合合并） | |
| FIND-06 | S2.6 | 未匹配路由渲染的是 Next 内置 404，正文为英文 `This page could not be found`，与全站中文文案不一致（项目无 `src/app/not-found.tsx`） | R9 `r9-d1` 的 `notFoundText`（截图 `d06-404.png` / `m06-404.png`） | OPEN（S2.6 只建基线不改代码；建议 S7.3 一并处理） | |
| FIND-07 | S3.2 | Jev 影子/接管走独立 HTTP 通道（`src/core/jev/live.ts` 直连 `JEV_BASE_URL`，默认 `https://api.typesafe.ai/v1/systemone`），**不经 `chat`/`chatStream`，因此 S3.2 的预算熔断管不到它**：单日花费上限对这条通道无效，且它的开关来自 `@prisma/client` 自动加载的仓库根 `.env`。本步只在测试与 e2e 侧删键止血（DEV-10），生产部署若开着 `JEV_*` 仍在守卫之外。**S3.4 追加实证**：删键对实机子进程根本无效（`next start` 里的 Prisma Client 自己读 `.env`），当天 :3120 实例日志累计 240 条 `[jev]` 出网记账 ≈$0.0100；改显式置 0 后新日志计数 0。生产侧仍未收口 | I11 的 fetch 探针：首轮同一配置下抓到 12 次出网，加删键后为 0；`.e2e/instance.log` 第 444/445 行前后 `[jev]` 计数 240 → 0（台账 S3.4 证据节） | OPEN（计划 P3 内无对应步骤：建议作为 P3 追加项，或并入 S6.1 的成本/日志口径时一并给 Jev 独立额度与显式开关） | |
| FIND-08 | S3.4 | 真人的「线索公开/私藏」决策没有回合限时：`armHumanTimeout` 覆盖读本（`engine.ts:466`）、自我介绍（`:496`）、选搜证地点（`:519`）、圆桌发言（`:574`）、回答提问（`discussion.ts:59`）、投票（`finale.ts:139`），独缺公开/私藏这一步。真人不做该决策时 SEARCH 阶段无限停等，全桌卡住；这是 FIND-03 那一族（真人回合限时口径）的一个确定实例 | 无需专用测试：R9 清单去掉缺陷后同一分支 5 秒内自行决策；缺陷运行留下实测读数（`game_events` seq 49→63 停等 5 分 26 秒） | OPEN（建议 S6.3 卡局告警一并处理：给这一步补限时与兜底，或在告警里显式点名） | |

## 实机测试记录
| 日期 | 阶段 | 场景 | 结果 | 耗时 | 证据路径 |
|---|---|---|---|---|---|
| 2026-09-27 | P2/S2.5 | R1 无模型冒烟 ×3（全新库连续 3 轮 up→smoke→down） | 3/3 PASSED，`action_failed=0`，voteResult 非空 | 61s / 62s / 61s | /tmp/s25-f-smoke-{1,2,3}.log（会话临时）；台账 S2.5 证据节 |
| 2026-09-27 | P2/S2.5 | R2 鉴权负向 | PASSED（403 / 仅 public / 401 / 401）×3 轮 | ~15s/轮 | scripts/e2e/auth.mjs |
| 2026-09-27 | P2/S2.5 | R3 SSE 断线续传 | PASSED（补传 3 条、与 DB 全集一致）×3 轮 | ~25s/轮 | scripts/e2e/sse-resume.mjs |
| 2026-09-27 | P2/S2.5 | R4 进程重启恢复 | PASSED（DISCUSSION r1 一致 → ENDED；日志异常计数 0） | ~4 分钟 | scripts/e2e/restart-resume.mjs |
| 2026-09-27 | P2/S2.6 | R9 浏览器走查 桌面 1280×800（清单 1–7） | PASSED 6/6 清单、31+25+36+32+29+18=171 步 0 失败；控制台 error 1（故意的 404）、异常 0；无横向滚动 | 60.2s（驱动内） | .e2e/screens/S2.6/{d01–d31a}.png、S2.6-d*-{d}-report.json |
| 2026-09-27 | P2/S2.6 | R9 浏览器走查 移动 375×812（触摸 + iPhone UA，清单 1–7） | PASSED 6/6 清单、171 步 0 失败；控制台 error 1（同上）、异常 0；5 页 + 对局页 + 观众页 scrollWidth=clientWidth=375 | 57.6s（驱动内） | .e2e/screens/S2.6/{m01–m31a}.png、S2.6-d*-{m}-report.json |
| 2026-09-27 | P3/S3.1 | R1 无模型冒烟（实例策略 = 生产默认 admin，建房带口令） | PASSED，`ENDED ✓`，`!! action failed` 计数 0 | 未单独计时（S2.5 同脚本量级 ~61s） | /tmp/e2e-smoke-s31.log（会话临时）；台账 S3.1 证据节 |
| 2026-09-27 | P3/S3.1 | R2 鉴权负向（含新增「无口令建 AI 房 → 403」「无口令建纯真人房 → 201」） | PASSED（6 条判据全中，403 文案逐字一致） | ~15s | scripts/e2e/auth.mjs |
| 2026-09-27 | P3/S3.1 | R3 SSE 断线续传（复跑） | PASSED（补传 3 条、seq 递增、与 DB 全集一致） | ~25s | scripts/e2e/sse-resume.mjs |
| 2026-09-27 | P3/S3.1 | R4 进程重启恢复（复跑，验证策略改动不影响停等/恢复） | PASSED（`重启后首读核对一致：DISCUSSION r1 turn=0` → ENDED；日志异常计数 0） | ~4 分钟 | scripts/e2e/restart-resume.mjs |
| 2026-09-27 | P3/S3.1 | R9 桌面续跑链 d3→d4a→d5→d4b（同一局，管理员会话） | PASSED 115 步 0 失败、控制台 error 0、异常 0；`tokenQueryRequests` 每玩家标签 1 条（FIND-04 不变） | 48.6s（驱动内合计） | .e2e/screens/S2.6/S2.6-{d3,d4a,d5,d4b}-d-report.json（见 DEV-09） |
| 2026-09-27 | P3/S3.1 | R9 负向清单 s31-unauthorized-create-room（无管理会话建房提交） | PASSED 9 步 0 失败：403 文案渲染在原表单（`stillOnForm=true`、`submitEnabled=true`）、无横向溢出 | 2.3s | .e2e/screens/S3.1/x01-rooms-new-403.png、S3.1-ui403-x-report.json |
| 2026-09-27 | P3/S3.3 | R1 无模型冒烟（凭证比对改走 credentials 后的整局） | PASSED，`voteResult {"caught":false,"counts":{"1":2,"3":1,"4":2},"tiedSeats":[1,4],"culpritSeat":3}`、`!! action failed` 0 | 未单独计时（run.mjs 不输出分段耗时） | /tmp/s33-e2esmoke.log（会话临时）；台账 S3.3 证据节 |
| 2026-09-27 | P3/S3.3 | R2 鉴权负向（座位/DM/房主三类凭证正负向，实机 HTTP） | PASSED（错 token action 403 / DM force_ready 200 / 观战与座位流过滤 / 无口令建 AI 房 403 / 纯真人房 201 / providers 401×2） | 未单独计时 | scripts/e2e/auth.mjs；/tmp/s33-e2esmoke.log |
| 2026-09-27 | P3/S3.3 | R3 SSE 断线续传（含心跳凭证重验路径） | PASSED（lastSeq=97 全量回放 1 条 → 补传 3 条 → seq 严格递增、与 DB 全集一致） | 未单独计时 | scripts/e2e/sse-resume.mjs；/tmp/s33-e2esmoke.log |
| 2026-09-27 | P3/S3.4 | R9 全量重跑 桌面 1280×800（生产强制 CSP，全新实例 pid=13502、无 Jev 出网） | PASSED 6/6 清单、31+25+36+32+29+18=171 步 0 失败；**CSP 违规 0**、控制台 error 1（故意的 404）、异常 0；13 个布局采样无横向滚动 | 57.2s（驱动内） | .e2e/chain-s34-r3.log、.e2e/screens/S2.6/{d01–d31a}.png + S2.6-d*-{d}-report.json |
| 2026-09-27 | P3/S3.4 | R9 全量重跑 移动 375×812（同一实例、同一套清单） | PASSED 6/6 清单、171 步 0 失败；**CSP 违规 0**、error 1（同上）、异常 0 | 56.0s（驱动内） | .e2e/chain-s34-r3.log、.e2e/screens/S2.6/{m01–m31a}.png + S2.6-d*-{m}-report.json |
| 2026-09-27 | P3/S3.4 | R9 缺陷运行（清单决策步未生效那一次） | 第 1 遍桌面 d4a FAILED（`等待元素超时: text:公开质询`，SEARCH 停等 5 分 26 秒）；第 2 遍桌面 + 移动 d4a 同时同因 FAILED → 判定为清单缺陷而非偶发，修复见 DEV-12 | 每遍各多花 ~5 分钟停等 | .e2e/chain-s34.log、.e2e/chain-s34-r2.log；`game_events` seq 49→63（game cmujkxw1d…） |
| 2026-09-27 | P3/S3.4 | 搜证决策分支定向验证（`pd` 前缀，跑到出现需决策线索为止） | 第 1 次无决策窗（skip 正确）；第 2 次真人抽到需决策线索 → **5 秒内自行点「暂时私藏」**并立刻进入圆桌讨论，d4a 32 步 0 失败 | ~40s/次 | .e2e/prove-decision.log、S2.6-d4a-pd-report.json；`game_events` seq 674→688→690（game cmujm3scd…） |
| 2026-09-27 | P3/S3.5 | R1 无模型冒烟（前端凭证层换成一次性票据后的整局） | PASSED，`ENDED ✓ voteResult {"caught":false,"counts":{"2":2,"3":1,"4":2},"tiedSeats":[2,4],"culpritSeat":3}`、无 `!! action failed` | 未单独计时（run.mjs 不分段） | .e2e/s35-e2e.log（`SMOKE_EXIT=0`）；台账 S3.5 证据节 |
| 2026-09-27 | P3/S3.5 | R2 鉴权负向（复跑，凭证判定改动后） | PASSED（无口令建 AI 房 403 / 纯真人房 201 / 错 token action 403 / DM force_ready 200 / 观战流只见公开 / providers 401×2） | 未单独计时 | scripts/e2e/auth.mjs；.e2e/s35-e2e.log |
| 2026-09-27 | P3/S3.5 | R3 SSE 续传 + **新增 ticket 段** | PASSED：原三段公开流断言不变（补传 3 条、与 DB 全集一致）；座位票流 5 条 ⊇ 公开全集 4 条且**地址无 `token=`**、主持票流 5 条、重放同一票 → 服务端按未鉴权降级、兼容期 `?seat=&token=` 仍可用且日志记废弃告警（日志内无 seatToken 明文） | 未单独计时 | scripts/e2e/sse-resume.mjs；.e2e/s35-e2e.log 第 241–252 行；实例日志新增 2 条 `[sse]` 告警 |
| 2026-09-27 | P3/S3.5 | R9 全量重跑 桌面 1280×800（`td` 前缀，生产强制 CSP，实例 :3120 无 Jev 出网） | PASSED 6/6 清单、31+25+36+32+29+18=171 步 0 失败；**`token=` 请求 0 条 / `ticket=` 2 条**、CSP 违规 0、控制台 error 1（故意的 404）、异常 0、13 个采样点无横向滚动 | 60.2s（驱动内） | .e2e/s35-r9-r2.log、.e2e/screens/S2.6/{td01–td31a}.png + S2.6-d*-{td}-report.json（game cmujnqk0c…，房间 GJDD6） |
| 2026-09-27 | P3/S3.5 | R9 全量重跑 移动 375×812（`tm` 前缀，同一实例同一套清单） | PASSED 6/6 清单、171 步 0 失败；**`token=` 0 条 / `ticket=` 2 条**、CSP 违规 0、error 1（同上）、异常 0、无横向滚动 | 56.2s（驱动内） | .e2e/s35-r9-r2.log、.e2e/screens/S2.6/{tm01–tm31a}.png + S2.6-d*-{tm}-report.json（game cmujnsx2y…，房间 DTVDL） |
| 2026-09-27 | P3/S3.5 | R9 首轮（`.e2e/s35-r9.log`）与链脚本自伤 | 首轮 12/12 exit 0，但链脚本按字节偏移切字符读入的日志，统计口径前移（只报「新增 1 行」）→ 改 `subarray` 后**整轮重跑**，上表为重跑结果；另按 gameId 核对本轮两局的服务端日志行数 = 0 | — | .e2e/s35-r9.log（首轮）、.e2e/plans/chain-s35.mjs（gitignore） |

## 推送与 CI 记录
| 日期 | 分支 | 推送范围 | CI |
|---|---|---|---|
| 2026-09-26 | opt/2026-09 | S0.1 首次 `push -u origin`（new branch） | — |
| 2026-09-26 | opt/2026-09 | P0/P1（至 24847c0） | check job 绿（run 36254901201） |
| 2026-09-26 | opt/2026-09 | P2 前半（至 70133f5） | integration job 首次绿（run 36259803390） |
| 2026-09-27 | opt/2026-09 | P2 收尾（S2.4–S2.6 + 阶段验收，`70133f5..b42d246`，9 个提交） | 绿：run 36302004848（check 与 integration 均 success，各约 50s） |
| 2026-09-27 | opt/2026-09 | P3 全部（S3.1–S3.5 + 阶段验收，`b42d246..fa21b69`，25 个提交，其中前 2 个是 P2 收尾的补记） | 绿：run 36312551209（check 1m0s、integration 1m1s） |

## 偏差登记
- **DEV-01（S0.4）**：计划 §1.1 称 `npm audit --omit=dev` 运行时链路为 0 high（3 high 全在 CLI 链路）。实测 `npm audit --omit=dev` 仍报 3 high（deepmerge-ts 经 @prisma/config ← prisma；prisma 在 devDependencies 中）。不影响任何指标的相对比较（后续只要求「不增加」），如实记录，不处理。
- **DEV-03（S2.4）**：计划预期「同一座位并发 2 个 speak 只记 1 条发言」放在 DISCUSSION 验证；实际 DISCUSSION 的 speak 不做回合推进（圆桌自由发言是既有语义，engine.ts DISCUSSION 分支不调 markSpoken）。回合门禁语义在 SELF_INTRO 成立，用例改在 SELF_INTRO 验证并仍断言只记 1 条。不改生产代码。
- **DEV-02（S1.3）**：ci-probe/lint-fail 的本地分支未删除——红线禁止 `git branch -D`，而 `git branch -d` 因分支未合并拒绝执行（分支内容仅为一个含 lint 错误的临时探针文件 src/__probe-lint__.ts，无保留价值）。远端分支已删除。留给用户清理：`git branch -D ci-probe/lint-fail`。
- **DEV-04（S2.5）**：L4 基建相对计划「具体操作」的 6 处增量/偏差，均为让场景可执行所需，不改产品行为：
  1. `up.mjs` 端口回退 3100→3110→3120（:3100 被一个来历不明的遗留 `next start` 占用：pid 60062 / 父 60036，12:15:03 启动，早于本会话首次工具调用；按「不杀未知进程」原则未触碰，只把自己的实例挪到 3110/3120）。计划 §3.5 的 :3100 语义保持不变（首选端口仍是 3100）。
  2. `up.mjs` 的实例 stdio 由 `pipe` 改为继承文件 fd：父进程 `process.exit()` 后管道读端关闭，实例写日志会拿到 EPIPE（此前那次「实例起来了但 instance.log 无新行」即此现象）。
  3. `up.mjs` 新增 `--keep-db`：计划的 up 总是 drop 重建 `jubensha_e2e`，而 R4 要求「保留库重启实例后继续同一局」。默认路径不变。
  4. 新增 `scripts/e2e/restart-resume.mjs`（R4 驱动）：`smoke-m3.mjs` 是一次性线性脚本，无法从「进程重启后的中断点」续跑；该驱动按阶段前置条件替真人出手，并把座位 token 只写进 gitignore 的 `.e2e/r4-state.json`（不变式 5）。
  5. `scripts/smoke-m3.mjs` 修 4 处「动作前置条件」：`choose_location` 先在 `availableLocations` 里选、`publish` 只在 SEARCH 阶段做、`speak` 后按 `turnSeat` 决定是否还需要 `skip`、`private_chat` 只在 `openWhispers` 有窗口时回复。修复前每轮 R1 输出 4 条 `!! action failed`，会让 §3.5 R1 的判据（输出里没有 `!! action failed`）永远不成立；这些都是脚本侧的非法动作尝试，不是引擎缺陷。
  6. R2 的「座位私有事件」探针由 DM `hint` 改为 `force_ready`：`hint` 需要 `hintIndex`（指向剧本 `hostGuide.stallBreakers`），且其产物是 public `system` 事件，无法验证 seat 过滤；`force_ready` 产生 `visibility=seat:N` 的事件且在读本阶段即可确定触发。
- **DEV-05（S2.5）**：接手时工作区除 S2.5 的 e2e 脚本外，还带着 `src/core/engine/engine.ts` 的 8 行调试探针（`globalThis.__tickProbe` + `console.error`，上一会话诊断 tick 循环所留，不属于任何计划步骤，且会让「非测试代码 console.*」指标变差、并把探针打进实机构建）。处理：`git diff` 存为 `.e2e/engine-tick-probe.patch`（gitignore 目录，未丢）后 `git restore`，不入库。留给用户：若还要用该探针，`git apply .e2e/engine-tick-probe.patch`。
- **DEV-06（S2.6）**：R9 的「用浏览器自动化工具（内置 Browser 面板）」改为**本机 Chrome（headless=new + 独立临时 profile）+ CDP**（新增 `scripts/e2e/browser.mjs`，零新增依赖：Node 内置 WebSocket + 本机 Chrome 路径）。原因：内置 Browser 面板未打开真实窗口时页面 `innerWidth=0`、`document.hidden=true`，既截不出图也判不了 375×812 的横向滚动（NATIVE_BROWSER_VIEWPORT_UNAVAILABLE）；CDP 能精确设两种视口、开触摸模拟与 iPhone UA、开独立 browser context（等价无痕窗口）、并汇总控制台 error / 未捕获异常 / 带 `token=` 的网络请求 —— 判据覆盖计划要求。附带 3 处基建增量：报告文件名带 `--shot-prefix`（否则桌面与移动同名互覆盖）、新增 `waitJs` 动作（等「结果态」而不是等瞬态文案）、报告内 `?token=` 一律掩码且口令只从 `.e2e/up.json` 读取。另附 `scripts/e2e/db-proof.sh`：R9 判定需要的落库侧证（seat 0 的搜证选择、线索公开/私藏、投票与结算、降级提示去重度量），只读查询、gameId 先做白名单正则、连接串取自 `.e2e/up.json`。
- **DEV-07（S2.6）**：R9 清单第 4 项的 3 个文案断言按实机语义改写，均不弱化「操作生效」这一判据：① 线索 `policy=auto_public` 时不存在公开/私藏决策窗（引擎直接公示并发 `该线索为公开线索，已向全场公示`），故该步用 `clickIf`，分支改由 DB 事件（`你决定私藏线索[…]` / `clue|public|publicBy:0`）证明；② SEARCH 选完地点后 `已选择，等待其他玩家搜证…` 是瞬态（其余座位秒选），改等「地点按钮不再可选」并 `collect` 当帧是否见到该提示；③ VOTE 后 `已投票，等待其他人…` 同理，改断言 `指认真凶` 面板消失 + `本局结算` 出现，票以 `votes` 表为准。
- **DEV-08（S3.1）**：开房授权策略的 5 处偏差/增量，均不改变 D2 的策略语义：
  1. 计划把 `src/app/rooms/new/page.tsx`（错误提示）列入涉及范围，实测**不需要改**：`src/lib/client.ts:14` 已把服务端 `error` 抛出、`src/app/rooms/new/page.tsx:176` 原样渲染，负向清单已作为行为证明，故本步零改动。附带后果：`invite` 模式在页面上没有邀请码输入框（只能靠 API 直接带 `inviteCode`），已在 `.env.example` 注释里写明；补 UI 不在本步范围。
  2. `admin` 模式多一条 fail-closed 分支：`isAdminRequest()` 在生产缺 `ADMIN_TOKEN` / `SECRET_MASTER_KEY` 时经 `assertAdminConfig()` 抛错，若照计划直调，玩家侧建房会变成被 `withRoute` 掩盖成固定文案的 500。改为 try/catch → 403「服务未正确配置管理员口令，暂时无法创建含 AI 座位的房间」，比计划的「未授权 → 403」更保守，并有 L2 用例锁定。
  3. e2e 实例改按**生产默认 `admin`** 跑，而不是在 `.env` 里设 `open` 走捷径 —— 否则 D2 的默认值没有任何实机证明。连带 4 处基建改动：`run.mjs` 用 `SMOKE_ADMIN_TOKEN` 把口令传给冒烟脚本；`smoke-m3.mjs`/`sse-resume.mjs`/`restart-resume.mjs` 的建房请求带 `x-admin-token`；`auth.mjs` 加 2 条负向；`browser.mjs` 新增 plan 级 `adminSession`（真实 `/api/admin/unlock` + CDP `Network.setCookie`，口令不进 plan/report/日志）。曾考虑 `ADMIN_TRUST_LOOPBACK=1`，但那会让 R2 既有的「伪造 Host → 401」断言失去意义，弃。
  4. `browser.mjs` 的 `--var` 由「后者覆盖前者」改为重复传参累加（逗号分隔），以便一次运行注入多个变量；单次的既有用法行为不变。
  5. 指标「非测试代码 console.*」27 → **30**：新增 3 条 `[room-policy]` 配置错误提示按 `src/lib/admin.ts:66`、`src/core/engine/registry.ts:25` 的现有约定直写 console（项目还没有统一 log 出口，S5.x 收敛）。不为 3 条日志发明只有这一处用的私有约定，但如实计入指标。
- **DEV-09（S3.1）**：自伤记录。第一次 R9 续跑链运行失败（漏 `--keep-browser`，且当时 `--var` 只保留最后一个参数，见 DEV-08 第 4 条），那次失败运行用新局数据**覆盖了 S2.6 的 3 份桌面报告**（`S2.6-d4a-d` / `S2.6-d5-d` / `S2.6-d4b-d`）。修正后的重跑已生成结构相同、但属于另一局的报告。影响范围：这些是 gitignore 的本地产物、不入库；S2.6 台账引用的数字（气泡数 32→31、seq 侧证等）出自当时的原始运行，现已无法从磁盘复现。S2.6 的结论与判据不改，其完整基线将在 S3.4 的全量 R9 重跑中重建。
- **DEV-10（S3.2）**：两处计划范围之外的改动，都是被 I11 的 fetch 探针逼出来的（不改就会在测试与实机里真花钱）：
  1. `src/test/int.ts:14` 的 `setupIntEnv()` 删除 `process.env` 里所有 `JEV_*` 键。根因：`@prisma/client` 会把仓库根 `.env` 自动加载进 `process.env`，本机 `.env` 开着 `JEV_SHADOW=1` / `JEV_FALLBACK=1`，于是每个 L3 对局都会对外部决策端点发真付费请求（首轮探针抓到 12 次）。测试环境不该由个人本地 `.env` 决定要不要出网。
  2. `scripts/e2e/up.mjs:95` 从实例 ENV 里同样删掉 `JEV_*`。**这是实机行为变化**：以前本机 `.env` 开着影子/接管时，实机实例会跟着走真外部决策；现在 e2e 实例一律是「无 Jev」链路。理由：§3.5 的实机判据本来就建立在无模型链路上，R8 的真模型场景走独立的 `E2E_LLM_*`；一次 e2e 是否花钱取决于开发者本地 `.env` 是不可接受的。需要在实机验证 Jev 时手工带 `JEV_*` 起实例，不通过 e2e 基建。**S3.4 更正**：这一处当时其实没有生效——删的是 `up.mjs` 父进程的 env，`next start` 子进程首次实例化 Prisma Client 时会自己读仓库根 `.env` 把键灌回来，当天实机仍出网 240 条（≈$0.0100）。已改为显式 `ENV.JEV_SHADOW="0"` / `ENV.JEV_FALLBACK="0"`（dotenv 不覆盖已存在的键），重启后新日志 `[jev]` 计数 0。第 1 条（L3 侧删键）经复核确实有效：I11 的 fetch 探针断言「0 次出网」在 S3.4 重跑里仍绿，不再展开机制解释。
  3. I11 的 fetch 探针保留为常驻守卫：L3 任何用例发出出网请求都会立刻失败，而不是悄悄产生账单。熔断管不到这条通道本身，另计 FIND-07。
- **DEV-11（S3.3）**：本步 3 处计划外/口径性处理，均不改认证语义：
  1. `gameEventsUrl` 从 `src/lib/join.ts` 拆到新的 `src/lib/game-events-url.ts`。计划把 join.ts 列为涉及范围，但 join.ts 同时被客户端 hook `useGameStream.ts` 引用，而 `credentials → admin` 依赖 `node:crypto` 与 `next/headers`；直接引用来会让生产构建失败（实测 `next build` exit 1：`You're importing a module that depends on "next/headers" … ./src/lib/credentials.ts [Client Component Browser]`）。拆开后 join.ts 为服务端专用，`gameEventsUrl` 的 4 条用例与断言原样保留只改 import 路径。**连带影响**：S3.5 的涉及范围里「`src/lib/join.ts` 的 `gameEventsUrl`」此后指向 `src/lib/game-events-url.ts`。
  2. 计划给的验收 grep `token\s*!==|!==\s*.*[Tt]oken` 会误报与凭证无关的行（`d.maxTokens !== undefined`、`s.kind !== "human" ? { token: null }`，以及任何「先判 `!== null` 再调 `verify*Token`」的写法）。为让判据字面成立而非另起一套口径，做了两处等价重写（`bindings/route.ts:78` 改成 `=== undefined` 分支、`rooms/[code]/route.ts` 的座位投影改成 `=== "human" ? {} : { token: null }`），并把另外两处改成不含 `!==` 的单行写法。两文件均非凭证逻辑，行为逐字不变。
  3. `verifyDmToken` 只回答「这是不是该房间的 DM token」，不含 `humanDm` 开关判断：`rooms/[code]` 的观战授权路径原本就不看 `humanDm`，其余调用点自己保留 `humanDm &&`。若要统一成「带模式判断」，需要先确认 `dmToken != null && !humanDm` 这一状态不可达（当前只有 `dm-join` 在 `humanDm: true` 条件下写 dmToken），属于另一件事，不在纯替换步里顺手改。
- **DEV-12（S3.4）**：S3.4 的涉及范围只有 `next.config.ts`，但「R9 全量重跑」这条判据在实机跑不通，为把判据真的立起来动了三处实机基建（都不改产品行为）：
  1. `scripts/e2e/up.mjs:96-99` 显式把 `JEV_SHADOW` / `JEV_FALLBACK` 置 0 —— DEV-10 第 2 条的更正，属于止血。
  2. `scripts/e2e/plans/r9-d4a-play-early.json:90,94` 给两个搜证决策步补 `text:` 前缀。**这是 R9 清单的行为变化**：从 S2.6 起这一步从未点过任何按钮（裸串被当标签选择器），修好后真人抽到需决策线索时会真的由 d4a 当场作出公开/私藏决定（桌面先私藏、移动先公开，与该清单原设计一致）。连带更正：S2.6 台账「公开/私藏两分支…有 DB 侧证」那条，当时作出决策的是后续 `d4b` 的 until 循环补点，不是 d4a 的真人决策步；「真人自己在决策窗里点」这条路径是 S3.4 才第一次真正跑到（`.e2e/prove-decision.log` 第 2 次运行 + `game_events` seq 688）。
  3. `scripts/e2e/browser.mjs:461/468/477/479` 的 `skip:` 记录改为替换后的选择器（纯报告口径，让「驱动到底找过什么」在报告里可读）。
  本步没有新增或修改任何 vitest 用例与断言，也没有放宽阈值；唯一的产品行为变化是生产 `script-src` 去掉 `'unsafe-eval'` 并转为强制头，由 R9 12 次运行「CSP 违规 0 + 整局走到 ENDED」证明没有合法资源被误伤。

- **DEV-13（S3.5）**：SSE 一次性票据的 4 处计划外/口径性处理，均不改鉴权语义：
  1. **前置冲突按依赖图执行**：S3.5 的步骤卡写「前置：S3.3、S5.1」，而附录依赖速查是 `S2.2 ─┬→ S3.1(D2), S3.3 → S3.5`（S5.1 与 S3.5 都在 `S2.2` 之后、彼此无上下游关系）。两处只有一个对，按「哪个更小可逆」判：步骤卡的前置若成立，P3 就要等 P5，而 S3.5 的暴露面（token 进访问日志）是当天已确认的不变式 5 问题；反过来 S5.1（心跳去 DB 化）不依赖票据。按图先做 S3.5，并把 S5.1 需要的那一半留好：连接作用域里保存的是**已验证的凭证快照**（`seatCredential` / `dmCredential`），S5.1 删掉心跳里的 `db.game.findUnique` 后，重验基准仍然在作用域内，不需要再回读库。
  2. **计划范围外的 `src/lib/rate-limit.ts`**：新增 `checkStreamTicketRateLimit`（同 IP 30/min + 全局 600/min）。签发端点是「长期凭证 → 可放进 URL 的短期凭证」的兑换口，也是本步唯一新增的公开写入口，不限流就等于给爆破凭证提供一个更快的循环；沿用文件里既有的 `rateLimit` 原语与 `{ok:false, retryAfterSec}` 形态，未新建机制。
  3. **R3 的「改用 ticket」改为「增补 ticket 段」**：计划测试项写「L4：R3 改用 ticket 后仍然通过」。把原有用例改写成 ticket 建流会让 R3 失去「匿名观战续传」这一既有覆盖（红线：不弱化既有断言）。做法是原三段公开流与全部断言逐字保留，只在末尾追加 ticket 段（座位票 / 主持票 / 重放必拒 / 兼容期 token query），并让兼容期检查读实例日志的新增量。判据覆盖面只增不减。
  4. **心跳重验改为凭证快照**（计划未提这一处连带）：ticket 用后即删，心跳若照旧从 `url.searchParams` 取凭证，则所有 ticket 连接都会在 20 秒后被自己踢下线。改为按签发时验证过的快照比对，并在 A29 用 fake timers 锁定两条语义：凭证未变 → 心跳周期内存活；座位 token 被轮换 → 一个心跳周期内收流。吊销检测能力与改动前等价（比对的仍是真凭证，只是基准来自快照）。
- **DEV-14（S4.3）**：GameState 版本化的 5 处口径/计划外处理，均不改快照读写语义（判据「重构 = 零行为漂移」由对照副本 8 用例 + I07 + R4 三面立住）：
  1. **`.passthrough()` → `.looseObject()`**：计划写「zod schema 对未知字段使用 `.passthrough()`」，但仓库里是 zod 4.5.4，`.passthrough()` 在 v4 已废弃（对象层的替代就是 `.loose()`）。按原意实现，`state-schema.ts` 全部对象节点用 `z.looseObject`，未知字段原样保留并有 L1 用例（`:102` 注入 `someFutureField` 后仍在）钉住。若照字面写 `.passthrough()` 会引一条 deprecation 警告，且将来 v4 移除时又要改。
  2. **`migrateState(raw, {now, gameId})` 而非计划的 `migrateState(raw)`**：兼容段里有两处外部输入——过期 `humanDeadlines` 要用「本次加载的时刻」比、legacy `questionId` 要用 `gameId` 拼。让迁移函数自己读 `Date.now()` 会把时钟藏进被测函数里，「未过期的保留」这条断言就只能在真实当下跑一次、无法确定化。改为调用方注入（`engine.ts:184` 传 `Date.now()`），行为与改动前一致，L1 因此能拿 fixture 内 baked 时刻做 ±1s 双向断言。
  3. **`ensureCurrentFields()` 每次加载都跑，而不是只在 v0 迁移里跑**：更「干净」的写法是把 24 条 `??=` 塞进 v0→v1 那一步，但那样 v1 快照就不再补字段——而 `initialState()` 本来就不产出 `suggestions` / `memory` 这类可选字段，旧 `load()` 对**任何**快照都会补，只补 v0 是行为漂移。因此按「零漂移」重排成：`MIGRATIONS` 只负责登记版本，补齐与清理对所有版本各跑一次（幂等）。对照副本里唯一需要抹平的差异恰好就是版本字段本身（喂进对照函数的输入已带 `stateVersion: 1`，两边各剥一层再比），其余 7 份快照与 4 种空输入深度相等。
  4. **`CURRENT_STATE_VERSION` 定义在 `types.ts`（`:29`），`state-migrate.ts:6` 再导出**：计划把常量归给 `state-migrate.ts`。`initialState()`（`state.ts`）必须用它，而 `state-migrate.ts` 已经 import `state.ts`；常量留在 state-migrate 会形成 state ↔ state-migrate 的模块环。放 types（纯类型/常量层，无依赖）两边都能引，出口仍从 state-migrate 再导一次，调用方按计划的名字与位置都能拿到。
  5. **给 `draft.clueStates?.[id]?.isPublic` 加了一层 `?.`**：原写法是 `state.clueStates[id]?.isPublic`，而 `clueStates` 本身在坏快照里可能缺席 → 迁移段先 TypeError，比改动前更早、且绕过了 schema 的结构化拒绝。加 `?.` 后坏数据照样被拒，只是改由 `parseGameState()` 的 ZodError 报出（`state-migrate.test.ts:113` 钉住「`clueStates: {c1:{discoveredBy:null}}` 被拒」）。路由侧两种错误都收敛成同一个固定 500 文案，对外行为不变。
