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
| 测试文件 / 用例（npx vitest run） | 55 / 387，约 3.2s | 55 / 387 | 不降 | S0.4 |
| L2 覆盖处理器（find src/app/api -name route.test.ts） | 1/34 | 1/34 | 34/34 | S0.4 |
| L2 用例数 | ~10（events route 10 个） | 10 | ≥ 140 | S0.4 |
| L3 用例数 | 0 | 0 | ≥ 30 | S0.4 |
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
| R1 无模型冒烟 | 未测 | 未测 | 连续 3 次 | — |
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

## 发现的缺陷
| 编号 | 发现于 | 描述 | 复现测试 | 状态 | 关闭提交 |
|---|---|---|---|---|---|
| BUG-01 | 审查 | games/[id] token 取值 query 优先，与注释相反 | A28 it.fails（待 S2.2 写入） | OPEN | |
| BUG-02 | 审查 | resolveBinding 注释称沿 fallback 查找，实际直接抛错 | — | OPEN | |
| BUG-03 | S2.2 | tts/[hash]：缓存行在但音频文件丢失时，createReadStream 的 ENOENT 异步抛出，try/catch 接不住 → 实际 200 后流中断而非 404 | A34 it.fails | OPEN | |
| FIND-01 | S0.4 | `repetition.test.ts`「只在尾部窗口内扫描」在 --coverage 插桩下超时失败（5392ms），非覆盖率模式通过；时间敏感用例，覆盖率门禁需容忍或后续修复 | npx vitest run --coverage | CLOSED（S1.3） | 4b71bd7 |

## 实机测试记录
| 日期 | 阶段 | 场景 | 结果 | 耗时 | 证据路径 |
|---|---|---|---|---|---|

## 偏差登记
- **DEV-01（S0.4）**：计划 §1.1 称 `npm audit --omit=dev` 运行时链路为 0 high（3 high 全在 CLI 链路）。实测 `npm audit --omit=dev` 仍报 3 high（deepmerge-ts 经 @prisma/config ← prisma；prisma 在 devDependencies 中）。不影响任何指标的相对比较（后续只要求「不增加」），如实记录，不处理。
- **DEV-02（S1.3）**：ci-probe/lint-fail 的本地分支未删除——红线禁止 `git branch -D`，而 `git branch -d` 因分支未合并拒绝执行（分支内容仅为一个含 lint 错误的临时探针文件 src/__probe-lint__.ts，无保留价值）。远端分支已删除。留给用户清理：`git branch -D ci-probe/lint-fail`。
