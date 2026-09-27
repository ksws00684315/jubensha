# L4 实机测试（e2e）

隔离实例 + 隔离库上跑真实 HTTP 流程。**绝不触碰** :3000 的用户进程与 `local.app.json` / 用户库。

## 环境构成

| 项 | 值 |
|---|---|
| 数据库 | `jubensha_e2e`（复用 `docker-compose.test.yml` 的 `pg-test`，宿主端口 5433） |
| 实例 | `next start`，默认 :3100（被占用时依次尝试 3110、3120），只绑定 127.0.0.1 |
| 配置 | `APP_CONFIG_PATH=.e2e/app.json`（隔离，读不到 `local.app.json`） |
| 凭据 | `ADMIN_TOKEN` / `SECRET_MASTER_KEY` 每次随机生成，写入 `.e2e/up.json`（已 gitignore） |
| 开房策略 | 实例是生产构建，按 D2 默认 `ROOM_CREATE_POLICY=admin`：建含 AI 座位的房要带管理员口令，所以 `smoke-m3` 用 `SMOKE_ADMIN_TOKEN`（由 `run.mjs` 从 `up.json` 注入），其余脚本直接读 `cfg.adminToken` |
| 模式 | 无模型（`jubensha_e2e` 不配置任何 binding），AI 发言降级为提示，流程仍须闭环 |
| 种子 | `seeds/sample-5p-cloudlanshan.json`（5 人）+ `seeds/generated/4p-huoguoju.json` + `seeds/generated/06p-hongyanbanhang.json` |

## 命令

```bash
npm run e2e:up      # 建库 → migrate → 按需 build → 起实例 → 导入 3 本种子
npm run e2e:smoke   # 依次执行 R1 → R2 → R3，任一失败退出码 1 并打印场景编号
npm run e2e:down    # 按 pid 文件杀实例 + drop 库；--keep-db 时保留库
npm run e2e:up -- --keep-db   # 沿用现有库重启实例（R4 用），不重置、不重导种子
```

`e2e:up` 可用变量：`E2E_PORT`（默认 3100）、`E2E_DATABASE_URL`。
所有脚本内置防呆：目标端口/URL 指向 :3000 时直接拒绝运行（除非显式 `E2E_ALLOW_3000=1`）。

## 场景

| # | 脚本 | 断言 |
|---|---|---|
| R1 | `scripts/smoke-m3.mjs`（`SMOKE_BASE` 取自 `.e2e/up.json` 的端口） | 15 分钟内到 ENDED；`voteResult` 非空；输出无 `!! action failed`（「已经选过」除外）；退出码 0。门禁要求连续 3 次通过 |
| R2 | `scripts/e2e/auth.mjs` | 无口令建含 AI 座位的房 → 403（生产默认 admin），无口令建纯真人房 → 201；错 token 发 action → 403；观战 SSE 收不到座位私有事件、DM 流能收到；无口令访问 `/api/providers` → 401；伪造 `Host: localhost` + `X-Forwarded-For: 127.0.0.1` → 401 |
| R3 | `scripts/e2e/sse-resume.mjs` | 断线期间产生新事件后带 `Last-Event-ID` 重连，补传 seq 严格递增、与 DB 全集比对不重不漏 |
| R4 | `scripts/e2e/restart-resume.mjs`（人工分两段执行，见下） | 进程重启后 phase/round 与重启前一致，能继续推进到 ENDED，日志无未捕获异常 |

## R4 进程重启恢复（操作步骤）

用「真人自动驾驶」把一局推到轮到真人的 DISCUSSION（引擎停等），记录 phase/round 后重启实例，再续跑到 ENDED。座位 token 只写入 `.e2e/r4-state.json`（gitignore），不打印。

```bash
npm run e2e:up
node scripts/e2e/restart-resume.mjs                    # ① 开局并停等，输出「已停等并记录 DISCUSSION r1」
npm run e2e:down -- --keep-db                          # ② 只杀实例，保留库
npm run e2e:up -- --keep-db                            # ③ 同一库重启实例（不重置、不重导种子）
node scripts/e2e/restart-resume.mjs --stage=resume     # ④ 首读核对 phase/round → 续跑到 ENDED
grep -cE "unhandled|UnhandledPromiseRejection|FATAL" .e2e/instance.log   # ⑤ 期望 0
npm run e2e:down
```

判定标准：第 ④ 步输出「重启后首读核对一致」与 `R4 PASSED`（`voteResult` 非空），且第 ⑤ 步为 0。
注意：`e2e:up` 默认会 drop 并重建 `jubensha_e2e`，R4 的第 ③ 步必须带 `--keep-db`。

## R9 浏览器实机走查（`browser.mjs`）

计划 §3.5 的 R9 清单（7 项，桌面 1280×800 与移动 375×812 各一遍）。驱动用的是**本机 Chrome `--headless=new` + CDP**（Node 内建 `WebSocket`，零新依赖），不是 Qoder 内置 Browser 面板：面板在后台标签上 `innerWidth=0`、`document.hidden=true`，截图和移动端布局判定都没有意义。CDP 能精确设定视口、开独立 browser context（等价无痕），并汇总控制台 error 与未捕获异常。

```bash
npm run e2e:up                                  # 先起隔离实例（端口见 .e2e/up.json）
npm run e2e:browser -- --plan=scripts/e2e/plans/r9-d1-static.json --shot-prefix=d
npm run e2e:browser -- --plan=... --width=375 --height=812 --mobile --shot-prefix=m
npm run e2e:browser -- --shutdown               # 只杀本 profile 的 Chrome，并清 profile（cookie/localStorage 不留到下一轮）
```

| 清单项 | plan | 覆盖 |
|---|---|---|
| 1 | `r9-d1-static.json` | 5 页可开、非白屏、无横向滚动，404 兜底 |
| 2 | `r9-d2-settings.json` | 独立上下文首访 = 锁定态；口令解锁；provider apiKey 掩码 |
| 3 | `r9-d3-create-room.json` | 5 人本 1 真人 + 4 AI → 房间码 → 另开无痕标签入座 → 开局 → `/play` |
| 4 | `r9-d4a-play-early.json` → `r9-d4b-play-vote.json` | READING/SELF_INTRO/SEARCH/DISCUSSION 与 VOTE/REVEAL/ENDED；中间插 d5 保证 5、6 项在局中执行 |
| 5、6 | `r9-d5-identity-spectator.json` | 刷新后身份/阶段/事件数一致；无痕上下文只带房间码或 `/play` 地址时看不到私有卡与私聊 |
| 7 | — | 首轮为基线留档，无上一阶段可比；后续阶段重跑时同名截图对比 |
| 附 | `s31-unauthorized-create-room.json` | S3.1 负向：默认上下文（无管理会话）走 UI 建 AI 房，断言服务端的 403 中文文案渲染出来、表单仍可用。截图前缀用 `x`，产物落在 `.e2e/screens/S3.1/`，不与 R9 基线同名 |

plan 顶层可加 `"adminSession": true`（目前只有 `r9-d3` 需要）：驱动先用 `.e2e/up.json` 里的口令打一次 `/api/admin/unlock`，把换来的管理会话 cookie 种进默认上下文，UI 才建得出含 AI 座位的房间（实例按 D2 默认 admin）。口令只在驱动进程内出现，不进计划文件也不进报告。

动作清单是 JSON（`actions` 数组），支持 `nav / reload / waitSelector / waitJs / click(If) / clickFirst / type(If) / pick(If) / press / shot / collect / assert / tabNew / attach / useTab / until`。选择器三种写法：CSS、`text:文案`（先在可交互元素里找，精确优先再取子串，再退到正文文本节点）、`label:文案`（label 包裹的控件）。`{BASE}`、`{ADMIN_TOKEN}` 与 `--var=k=v` 注入的变量会在执行前替换。`waitJs` 轮询一段返回布尔的脚本，用于「只能等结果态」的步骤。

产物：`.e2e/screens/S2.6/<step>-<shot 前缀>-report.json`（步骤、失败、`collect` 值、每标签的控制台 error / 异常 / 带 `token=` 的请求、布局度量；同一 plan 的桌面 `d` 与移动 `m` 两份报告互不覆盖）与同名截图前缀 PNG；所有运行的 error 汇总追加到 `.e2e/screens/console-errors.jsonl`。目录与文件都不入库。

UI 判据之外还要落库侧证时用 `zsh scripts/e2e/db-proof.sh <gameId>`：输出真人座位的 `choose|…`、`clue|…|公开次数=`（0=仍私藏）、`notice|…条/种文案`（降级提示去重度量）、`vote|seatN->M`、`state|phase|rN|status|voteResult`。只读查询，连接串取 `.e2e/up.json`。

已知判定口径：
- SEARCH 的「当场公开 / 暂时私藏」决策窗只在线索 `policy ≠ auto_public` 时出现；`r9-d4a` 用 `--var=decisionFirst=…` 决定先点哪一边（桌面先私藏、移动先公开），两边都是 `clickIf`，无决策窗时记 skip 不算失败。
- 投票成功后 `已投票，等待其他人…` 是瞬态文案（无模型局其他座位秒投），断言改看 `本局结算`，真人票以 `votes` 表落库为准。
- SEARCH 的 `已选择，等待其他玩家搜证…` 同样是瞬态文案：其余座位选完就推进出 SEARCH，该提示可以整帧不渲染（桌面抓到过、移动没抓到）。判定改为「地点按钮不再可选」的 `waitJs`，并把当帧是否见到确认提示 `collect` 成 `searchAck` 留档，不当失败。
- SELF_INTRO 真人发言后回合自动结束，`跳过本轮发言` 同样只是 `clickIf`。

## 排障

- `EADDRINUSE` / 端口被占用：`up.mjs` 会自动改用 3110、3120（三者全忙才失败）。实际端口见 `.e2e/up.json`。
- 遗留实例杀不掉（`.e2e/up.json` 丢了）：`lsof -nP -iTCP:3100 -sTCP:LISTEN` 找到 pid，确认命令行是本项目 `next start` 后再手工 `kill`。
- 实例 60s 未就绪：看 `.e2e/instance.log`。
- `POST /api/rooms` 限流 5 次/分钟·IP：R2 一次跑 3 次建房（403 用例、纯真人房、正式开局），紧跟着跑 R3/R9 若撞上 429，等一分钟再试，别误判成授权失效。
- 建 AI 房返回 403「创建含 AI 座位的房间需要管理员身份」：脚本漏了 `x-admin-token`，或浏览器 plan 没标 `adminSession`（见上）。
- pg-test 容器没起：`npm run db:test:up`。
