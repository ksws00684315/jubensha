# L4 实机测试（e2e）

隔离实例 + 隔离库上跑真实 HTTP 流程。**绝不触碰** :3000 的用户进程与 `local.app.json` / 用户库。

## 环境构成

| 项 | 值 |
|---|---|
| 数据库 | `jubensha_e2e`（复用 `docker-compose.test.yml` 的 `pg-test`，宿主端口 5433） |
| 实例 | `next start`，默认 :3100（被占用时依次尝试 3110、3120），只绑定 127.0.0.1 |
| 配置 | `APP_CONFIG_PATH=.e2e/app.json`（隔离，读不到 `local.app.json`） |
| 凭据 | `ADMIN_TOKEN` / `SECRET_MASTER_KEY` 每次随机生成，写入 `.e2e/up.json`（已 gitignore） |
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
| R2 | `scripts/e2e/auth.mjs` | 错 token 发 action → 403；观战 SSE 收不到座位私有事件、DM 流能收到；无口令访问 `/api/providers` → 401；伪造 `Host: localhost` + `X-Forwarded-For: 127.0.0.1` → 401 |
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

## 排障

- `EADDRINUSE` / 端口被占用：`up.mjs` 会自动改用 3110、3120（三者全忙才失败）。实际端口见 `.e2e/up.json`。
- 遗留实例杀不掉（`.e2e/up.json` 丢了）：`lsof -nP -iTCP:3100 -sTCP:LISTEN` 找到 pid，确认命令行是本项目 `next start` 后再手工 `kill`。
- 实例 60s 未就绪：看 `.e2e/instance.log`。
- pg-test 容器没起：`npm run db:test:up`。
