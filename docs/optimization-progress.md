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
| 测试文件 / 用例（npx vitest run） | 55 / 387，约 3.2s | 78 / 558，约 4.1s | 不降 | S2.5 |
| L2 覆盖处理器（find src/app/api -name route.test.ts） | 1/34 | 22/22 个 route.ts 文件都有同名测试（覆盖全部 34 个导出处理器） | 34/34 | S2.2（S2.6 复测） |
| L2 用例数 | ~10（events route 10 个） | 165 过 + 2 it.fails（`npm run test:api`，23 files，2.5s） | ≥ 140 | S2.2（S2.6 复测） |
| L3 用例数 | 0 | 10（3 files） | ≥ 30 | S2.5 |
| src/lib 行覆盖率（vitest --coverage, L1 口径） | 58.26%（201/345） | 58.26% | ≥ 80% | S0.4 |
| src/app/api 行覆盖率（同上） | 76.14%（67/88） | 76.14% | ≥ 80% | S0.4 |
| src/core/engine 行覆盖率（同上） | 71.98%（1166/1620） | 71.98% | ≥ 基线 | S0.4 |
| 非测试代码 console.*（grep，排除 .test.） | 27 | 27 | 0（log.ts 除外） | S0.4 |
| 非测试代码 as unknown as（grep，排除 .test.） | 12 | 12 | ≤ 3 | S0.4 |
| engine.ts 行数（wc -l） | 1044 | 1044 | ≤ 700 | S0.4 |
| handleActionInner 函数体 | :670–:945 ≈ 275 行 | 275 | ≤ 60 | S0.4 |
| games/[id]/route.ts 行数（wc -l） | 185 | 185 | ≤ 70 | S0.4 |
| SSE 稳态 DB 查询/连接/分钟 | 未测 | 未测 | 0 | — |
| npm audit（全量） | 3 high（prisma→@prisma/config→deepmerge-ts，CLI 链路） | 3 high | 不新增 | S0.4 |
| npm audit --omit=dev | 3 high（复测仍含 CLI 链路，见偏差 DEV-01） | 3 high | 0 | S0.4 |
| CI | 无（无 .github/） | 无 | push 自动 check | S0.4 |
| R1 无模型冒烟 | 未测 | 连续 4 次通过，~61s/次（e2e 实例 :3110/:3120） | 连续 3 次 | S2.5 |
| R9 浏览器走查（桌面 1280×800 / 移动 375×812） | 未测 | 两遍各 171 步 0 失败，6/6 清单通过 | 两遍全绿 | S2.6 |
| R9 控制台 error / 未捕获异常 | 未测 | error 2（12 次运行合计，全部是第 1 项故意的 404）/ 异常 0 | 除故意负向用例外为 0 | S2.6 |
| UI 基线截图（`.e2e/screens/S2.6/`，不入库） | 0 | 64 张（桌面 d01–d31a 32 + 移动 m01–m31a 32） | ≥ 20 | S2.6 |
| SSE URL 带 `token=` 的请求（R9 网络捕获，每玩家标签页） | 未测 | 1 | 0（S3.5） | S2.6 |
| API 处理器总数（grep export const GET|POST|…） | 34（计划 §1.1 记 35，复测为准） | 34 | — | S0.4 |
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
  - 落库侧证（`zsh .e2e/plans/db-proof.sh <gameId>`，psql 只读查询）：
    - 桌面局 `cmujgkpif00aes83piruui3nw`：`choose|seq581|r1|书房`、`choose|seq614|r2|门廊雪地`；`seq594 system|seat:0|你决定私藏线索【遗体初验与胃内容物试验】` → **私藏分支**成立，`state.heldClues."0"=["tea_autopsy","footprint"]`，且两卡最终 `clueStates.*.isPublic=true`（第 2 轮结束由主持公开）；`vote|seat0->1` + `voteEvent seq657 evidenceIds=["teacup"]` → 引证据投票成立；`state|ENDED|ended|{"caught":false,"counts":{"0":2,"1":1,"3":1,"4":1},"culpritSeat":3}`。
    - 移动局 `cmujgn2xn00bus83py3hj6j9i`：`choose|seq676|r1|书房`；`seq691 clue|public|{"clueId":"tea_autopsy","publicBy":0}` → **当场公开分支**成立；`seq721 seat:0|你决定私藏线索【雪地脚印】` → 同一局内两个分支都验到；`vote|seat0->1`、`state|ENDED|ended|{"caught":false,"counts":{"1":3,"2":1,"3":1},"culpritSeat":3}`。
  - 决策窗并非每卡都有：`policy=auto_public` 的线索（如【参茶残液】）发牌即 `system|seat:0|…该线索为公开线索，已向全场公示。`，不出现公开/私藏按钮 —— 属既有设计，清单第 4 项的按钮步骤因此用 `clickIf`，无窗口时记 skip；分支证据以上述 DB 事件为准。
- 第 5 项细节：刷新前后 `bubbles` 桌面 32→32、移动 31→31，`phase` 文本一致（`搜证 · 第 2 轮 ✓ 读本 ✓ 自我介绍`），`privateCardShown=true`（我的剧本页签含「你的秘密」），`lsKeys=1`（座位凭证留在 localStorage）→ 刷新不产生渲染重复、身份保持。同屏出现的 5 组同文案气泡经核对是 **12 条独立 `system|public` 事件（4 种文案）** 的降级提示，不是渲染重复 → 见 FIND-05。
- 第 6 项细节（独立 browser context = 无痕等价）：只带房间码打开 `/rooms/{code}` → 只有「回到本局」与「请使用原设备凭证恢复」提示，`localStorageKeys=0`，无「你的秘密」；直连 `/play/{gameId}` → 出现「观众身份观看」，无「你的行动」面板、无线索（页签内 `还没有获得任何线索`）、正文不含「私聊」。桌面 `spectatorView.bubbles=20`、移动 21（仅公开事件）。
- 凭证外泄审计：驱动记录到 `tokenQueryRequests`，两遍各 1 条（d3 与 d5 的玩家标签）：`/api/games/{id}/events?seat=0&token=…`（报告里已掩码）。这是清单第 6 项/?token= 审计的基线值 → 见 FIND-04，由 S3.5 关闭。页面 URL、`document.body` 与 `localStorage` 均无 token 明文（`feedHealth.tokenInUrl=false`、`sseHasToken=false`）。
- 收尾：`npm run e2e:down` 后 `SELECT count(*) FROM pg_database WHERE datname='jubensha_e2e'` → 0；`node scripts/e2e/browser.mjs --shutdown` 清 profile；pm2 `jubensha`（:3000）restarts 未变。

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

## 发现的缺陷
| 编号 | 发现于 | 描述 | 复现测试 | 状态 | 关闭提交 |
|---|---|---|---|---|---|
| BUG-01 | 审查 | games/[id] token 取值 query 优先，与注释相反 | A28 it.fails（待 S2.2 写入） | OPEN | |
| BUG-02 | 审查 | resolveBinding 注释称沿 fallback 查找，实际直接抛错 | — | OPEN | |
| BUG-03 | S2.2 | tts/[hash]：缓存行在但音频文件丢失时，createReadStream 的 ENOENT 异步抛出，try/catch 接不住 → 实际 200 后流中断而非 404 | A34 it.fails | OPEN | |
| FIND-02 | S2.3 | vi.useFakeTimers 下引擎定时器链不收敛：AI ready 定时器延迟膨胀（5s 实际 ~60s）、SEARCH 阶段后台决策的互斥提交不落账。真实定时器 + 轮询路径正常。I06 已改为真实定时器 + 状态快进；完整流程由 R1 实机覆盖 | recovery.int.test.ts | OPEN（测试环境观察，非生产行为证明） | |
| FIND-03 | S2.5 | 实机 VOTE 阶段真人座位停等 8 分钟以上，未见 `HUMAN_TURN_TIMEOUT_MS`（180s）到点自动出手；当时测试脚本自身有缺陷（一直发 speak 未发 vote），不能据此判定产品缺陷。S6.3 卡局告警落地后用 `restart-resume.mjs` 复现一次 | scripts/e2e/restart-resume.mjs（待定版） | OPEN（待复现） | |
| FIND-01 | S0.4 | `repetition.test.ts`「只在尾部窗口内扫描」在 --coverage 插桩下超时失败（5392ms），非覆盖率模式通过；时间敏感用例，覆盖率门禁需容忍或后续修复 | npx vitest run --coverage | CLOSED（S1.3） | 4b71bd7 |
| FIND-04 | S2.6 | 前端 SSE 建连把座位 token 放进 URL query：`GET /api/games/{id}/events?seat=0&token=…`，会进浏览器历史与反向代理访问日志（不变式 5 的暴露面）。R9 网络捕获基线 = 每个玩家标签 1 条 | scripts/e2e/browser.mjs 的 `tokenQueryRequests`（`.e2e/screens/S2.6/S2.6-d5-{d,m}-report.json`） | OPEN（S3.5 一次性票据关闭） | |
| FIND-05 | S2.6 | 无模型局 ChatFeed 里「（AI 玩家「X」思考时遇到问题：用途槽位 "player" 尚未绑定模型…）」这类降级提示按座位×回合重复记录为公开事件：一局 5 人出现 12 条事件、只有 4 种文案，同屏 5 组重复行，观众也能看到。事件不重复（渲染无 bug），是引擎侧提示未去重 | R9 `r9-d5` 的 `identityBefore/After.bubbles vs uniqueTexts` + `psql … group by type,visibility`（台账 S2.6 证据节） | OPEN（建议 S7.3 关闭：同类 notice 按回合合并） | |
| FIND-06 | S2.6 | 未匹配路由渲染的是 Next 内置 404，正文为英文 `This page could not be found`，与全站中文文案不一致（项目无 `src/app/not-found.tsx`） | R9 `r9-d1` 的 `notFoundText`（截图 `d06-404.png` / `m06-404.png`） | OPEN（S2.6 只建基线不改代码；建议 S7.3 一并处理） | |

## 实机测试记录
| 日期 | 阶段 | 场景 | 结果 | 耗时 | 证据路径 |
|---|---|---|---|---|---|
| 2026-09-27 | P2/S2.5 | R1 无模型冒烟 ×3（全新库连续 3 轮 up→smoke→down） | 3/3 PASSED，`action_failed=0`，voteResult 非空 | 61s / 62s / 61s | /tmp/s25-f-smoke-{1,2,3}.log（会话临时）；台账 S2.5 证据节 |
| 2026-09-27 | P2/S2.5 | R2 鉴权负向 | PASSED（403 / 仅 public / 401 / 401）×3 轮 | ~15s/轮 | scripts/e2e/auth.mjs |
| 2026-09-27 | P2/S2.5 | R3 SSE 断线续传 | PASSED（补传 3 条、与 DB 全集一致）×3 轮 | ~25s/轮 | scripts/e2e/sse-resume.mjs |
| 2026-09-27 | P2/S2.5 | R4 进程重启恢复 | PASSED（DISCUSSION r1 一致 → ENDED；日志异常计数 0） | ~4 分钟 | scripts/e2e/restart-resume.mjs |
| 2026-09-27 | P2/S2.6 | R9 浏览器走查 桌面 1280×800（清单 1–7） | PASSED 6/6 清单、31+25+36+32+29+18=171 步 0 失败；控制台 error 1（故意的 404）、异常 0；无横向滚动 | 60.2s（驱动内） | .e2e/screens/S2.6/{d01–d31a}.png、S2.6-d*-{d}-report.json |
| 2026-09-27 | P2/S2.6 | R9 浏览器走查 移动 375×812（触摸 + iPhone UA，清单 1–7） | PASSED 6/6 清单、171 步 0 失败；控制台 error 1（同上）、异常 0；5 页 + 对局页 + 观众页 scrollWidth=clientWidth=375 | 57.6s（驱动内） | .e2e/screens/S2.6/{m01–m31a}.png、S2.6-d*-{m}-report.json |

## 推送与 CI 记录
| 日期 | 分支 | 推送范围 | CI |
|---|---|---|---|
| 2026-09-26 | opt/2026-09 | S0.1 首次 `push -u origin`（new branch） | — |
| 2026-09-26 | opt/2026-09 | P0/P1（至 24847c0） | check job 绿（run 36254901201） |
| 2026-09-26 | opt/2026-09 | P2 前半（至 70133f5） | integration job 首次绿（run 36259803390） |
| 2026-09-27 | opt/2026-09 | P2 收尾（S2.4–S2.6 + 阶段验收，`70133f5..b42d246`，9 个提交） | 绿：run 36302004848（check 与 integration 均 success，各约 50s） |

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
- **DEV-06（S2.6）**：R9 的「用浏览器自动化工具（内置 Browser 面板）」改为**本机 Chrome（headless=new + 独立临时 profile）+ CDP**（新增 `scripts/e2e/browser.mjs`，零新增依赖：Node 内置 WebSocket + 本机 Chrome 路径）。原因：内置 Browser 面板未打开真实窗口时页面 `innerWidth=0`、`document.hidden=true`，既截不出图也判不了 375×812 的横向滚动（NATIVE_BROWSER_VIEWPORT_UNAVAILABLE）；CDP 能精确设两种视口、开触摸模拟与 iPhone UA、开独立 browser context（等价无痕窗口）、并汇总控制台 error / 未捕获异常 / 带 `token=` 的网络请求 —— 判据覆盖计划要求。附带 3 处基建增量：报告文件名带 `--shot-prefix`（否则桌面与移动同名互覆盖）、新增 `waitJs` 动作（等「结果态」而不是等瞬态文案）、报告内 `?token=` 一律掩码且口令只从 `.e2e/up.json` 读取。
- **DEV-07（S2.6）**：R9 清单第 4 项的 3 个文案断言按实机语义改写，均不弱化「操作生效」这一判据：① 线索 `policy=auto_public` 时不存在公开/私藏决策窗（引擎直接公示并发 `该线索为公开线索，已向全场公示`），故该步用 `clickIf`，分支改由 DB 事件（`你决定私藏线索[…]` / `clue|public|publicBy:0`）证明；② SEARCH 选完地点后 `已选择，等待其他玩家搜证…` 是瞬态（其余座位秒选），改等「地点按钮不再可选」并 `collect` 当帧是否见到该提示；③ VOTE 后 `已投票，等待其他人…` 同理，改断言 `指认真凶` 面板消失 + `本局结算` 出现，票以 `votes` 表为准。
