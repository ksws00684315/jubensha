# 工程优化迭代计划 · 2026-09-26

> 交付对象：负责持续迭代开发的执行代理（agent）。本计划自包含，按步骤顺序执行即可。
> 项目：`/Users/hh-mini/Public/dev/jubensha`（Next.js 16 + React 19 + TS + Prisma/PostgreSQL + Vitest，pm2 跑 `next start` 于 :3000）。
> 上游依据：2026-09-26 架构审查（七维度 + 13 项优先级清单）。本文把那 13 项展开为可执行、可验收的步骤。
> 相关既有计划：`docs/engine-debt-rectification-plan.md`、`docs/engine-gameplay-batch-plan.md`（其中的硬性不变式继续有效，见 §1.3）。

---

## 目录

- §0 执行协议（agent 必读）
- §1 基线事实、硬性不变式、需用户拍板的决策点
- §2 标准门禁与全局验收指标
- §3 测试体系：L1 单元 / L2 API 路由 / L3 API 集成 / L4 实机
- §4 阶段与步骤（P0 → P8，共 39 步）
- §5 整体验收（计划完成判定）
- §6 进度台账模板

---

## §0 执行协议（agent 必读）

### 0.1 迭代循环

每一步（`Sx.y`）严格按以下循环执行，**不得跳步合并**：

1. **读**：读本步全文 + 本步「涉及范围」列出的所有文件。发现代码事实与本文描述不一致时，以代码为准，在台账「偏差」栏记录，并判断是否影响本步设计；影响设计时按 §0.2「设计错误」的规则处理（无人值守，不提问）。
2. **查前置**：确认「前置」列出的步骤在台账中为 `DONE`；按 §1.4 的最终决策执行。
3. **跑基线**：执行标准门禁 `G-std`（§2.1），记录结果。基线不绿时先修复或报告，不在红基线上开发。
4. **实施**：只做本步「具体操作」列出的改动。不顺手改进相邻代码（全局 CLAUDE.md §3）。
5. **测**：按本步「测试」小节补写/执行测试。
6. **验**：逐条核对本步「验收标准」。**每一条都必须有证据**（命令 + 输出摘要 / 测试名 / 截图路径）。
7. **记**：更新 `docs/optimization-progress.md`（§6 模板）：状态、证据、指标、偏差。
8. **交**：按 §0.3 提交。

### 0.2 失败处理

- 同一步验收失败：最多 3 轮修复尝试。第 3 轮仍失败 → 台账标 `BLOCKED`，写清失败的验收项、已尝试方案、怀疑的根因，然后跳到**不依赖本步**的下一步。
- 发现本计划有设计错误（例如某前提不成立）：本计划以**无人值守**方式执行，不向用户提问。处理方式：
  1. 在台账「偏差」栏写明问题、备选方案（≤ 2 个）；
  2. 选择**改动面最小、可回滚、不改变对外行为**的方案继续执行，并标注 `DONE(deviation)`；
  3. 如果所有备选方案都会改变对外行为或数据结构，就标 `NEEDS-DECISION`，跳过本步及依赖它的步骤，继续执行其他步骤。
- 任何时候 `G-std` 由绿转红且无法在本步内修复：`git restore`/`git revert` 回到上一绿点，不带红提交。
- 环境类故障（docker 未启动、端口被占用、网络不通）：先自行排查修复（启动 docker、换端口 3100→3110 等）；30 分钟内修不好就标 `BLOCKED(env)`，跳到不依赖该环境的步骤。
- **只有在剩余全部步骤都处于 BLOCKED / NEEDS-DECISION 时才停止**，并输出最终报告（见 §0.5）。

### 0.5 停止条件与最终报告

执行在以下两种情况之一时结束：(a) §5 整体验收全部满足；(b) 剩余步骤全部无法推进。结束时：

1. 更新台账到最终状态并提交、push `opt/2026-09`；
2. 在台账末尾追加「最终报告」一节：完成步骤数 / 总步骤数、§2.4 指标的最终值对照表、所有 BLOCKED 和 NEEDS-DECISION 的清单（附原因与建议）、R1–R9 的最后一次结果、需要用户后续处理的事项（例如合并 `opt/2026-09` 到 main、在生产库执行 S8.1 的检查 SQL）。

### 0.3 提交规范

- Conventional commits，中文描述，scope 后带步骤号：`test(api): 路由鉴权矩阵覆盖 games/* [S2.2]`。
- 一步至少一个提交，每个提交单独满足 `G-std`。重构步骤（P7）要求「纯搬移」与「行为修改」分开提交。
- **只提交本步改动的文件**：用 `git add <path>` 逐个添加，禁止 `git add -A` / `git add .`（工作区可能有用户未提交的改动）。
- 提交与 push 的授权范围见 §1.4 的 D1、D4：只在 `opt/2026-09` 上提交；每完成一个阶段（P）push 一次 `opt/2026-09`，并在台账记录 CI 运行结果。push 失败（未登录、网络问题）不阻塞，记为 `push-pending`，下个阶段再试。
- 提交信息末尾附加：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

### 0.4 禁止事项

- 不连接、不修改用户日常使用的数据库（`local.app.json` / `.env` 里的 `DATABASE_URL`）。所有需要真库的测试只用 §3.4 定义的专用库 `jubensha_test` / `jubensha_e2e`。
- 不重启用户的 pm2 进程 `jubensha`（:3000）。实机测试一律起独立实例于 :3100（§3.5）。
- 除 R8（按 D5 限额）外，不调用任何真实 LLM；L1–L3 与 R1–R7、R9 一律在无模型或 mock 模式下运行。
- 不引入 §1.4 未批准的新依赖。
- 不改写 main 的历史，不在 main 上提交。
- 不切回 main 做任何修改；不执行 `git reset --hard`、`git clean`、`git push --force`、`git branch -D`。
- 不修改 `.env`、`local.app.json`、`local.init.json`、`local.llm.json`；不读取或输出其中的密钥值。

---

## §1 基线事实、硬性不变式、决策点

### 1.1 基线事实（2026-09-26 实测，执行 S0.4 时复测并以复测值为准）

| 指标 | 基线值 | 采集命令 |
|---|---|---|
| 测试文件 / 用例 | 55 / 387，全通过，约 4s | `npx vitest run` |
| tsc 错误 | 0（审查时为 2，已在 main `39a81da` 中修复） | `npx tsc --noEmit` |
| eslint | 0 error / 1 warning（`src/core/engine/flow.ts:18` `_discussionRounds`） | `npx eslint src` |
| 非测试代码 `console.*` | 27 处 | `grep -rn 'console\.\(log\|warn\|error\)' src --include='*.ts' --include='*.tsx' \| grep -v '\.test\.' \| wc -l` |
| 非测试代码 `as unknown as` | 12 处 | 同上，模式换成 `as unknown as` |
| `engine.ts` 行数 | 1044；`handleActionInner` 约 :670–:945，`handleDmActionInner` 约 :950–:1044 | `wc -l` |
| `games/[id]/route.ts` 行数 | 185 | `wc -l` |
| API 路由处理器 | 35 个（见 §3.3 表） | `grep -rn 'export const \(GET\|POST\|PUT\|PATCH\|DELETE\)' src/app/api` |
| 有路由测试的处理器 | 1 个（`GET /api/games/[id]/events`） | `ls src/app/api/**/route.test.ts` |
| `recordEvent`/`persist` 调用点 | 84 处（src/core，非测试） | grep |
| `engine.events` 读取点 | 19 处 | grep `\.events\.` |
| npm audit | 3 high（`prisma → @prisma/config → deepmerge-ts`，CLI 链路） | `npm audit` |
| CI | 无（无 `.github/`）；远端 `origin = github.com/ksws00684315/jubensha` | — |
| 未提交 WIP | 0（用户已于 main `39a81da` 提交全部 WIP，含本计划初版） | `git status --short` |
| `.env.example` | **未被 git 跟踪**（被 `.gitignore` 的 `.env*` 吞掉） | `git ls-files .env.example` 输出为空 |
| 种子剧本 | `seeds/*.json` + `seeds/generated/*.json` 共 25 个 V2 文件（以实际 `ls` 为准） | — |

**关键代码事实（执行时须核对）：**

- `resolveDatabaseUrl()`（`src/lib/app-config.ts`）**优先读 cwd 下的 `local.app.json`，其次才是 `DATABASE_URL`**。因此仅设环境变量无法把实例指向测试库，S1.2 专门解决。
- 座位 token 只在大厅阶段变更（`PATCH /api/rooms/[code]` 改座位类型时置 null；join/dm-join 认领时写入）。对局开始后座位 token 不再变化。S5.1 依赖这一事实，执行前须 grep 复核。
- Prisma 使用连接池：**会话级 `pg_advisory_lock` 不可靠**（加锁与解锁可能落在不同连接）。S4.1 因此采用「租约列」方案，而不是审查报告里提到的 advisory lock。
- `scripts/validate-script-v2.ts` 支持传入多个文件，任一失败则 `exit 1`。
- `scripts/import-seeds.mjs` 的 BASE 硬编码为 `http://localhost:3000`，S2.5 要把它参数化。
- `scripts/smoke-m3.mjs` 支持 `SMOKE_BASE`、`SMOKE_SCRIPT` 环境变量，成功走到 ENDED 后正常退出，失败 `exit 1`。

### 1.2 本计划的范围

**包含**：审查报告的全部 13 项（P0–P2）；测试体系（L2/L3/L4）新建；CI；可观测性。
**不包含**：玩法、提示词、剧本内容、前端视觉改版、Prisma/eslint 大版本升级（只评估不执行）、多副本横向扩展（只做单写者保护）。

### 1.3 硬性不变式（任何一步违反即返工）

1. **信息防火墙**：AI prompt 只经 `src/core/agents/context.ts` 取数；不得新增取数路径。玩家可见数据只经 `visibleTo` 过滤。
2. **前缀缓存**：同一座位的 system 整局不变；动态内容放 user 尾部。
3. **旧档兼容**：已有数据库里的 `games.state` 快照必须能被新代码加载并继续对局（S4.3 之前靠 `??=`，之后靠迁移函数）。
4. **SSE 三处一致**：新增或改动事件类型时，`renderEventLog`（LLM 视角）、events 路由 `visibleTo`、前端 `EventBubble` 必须同步。
5. **错误不外泄**：路由 500 只回固定文案（`withRoute`）；日志中不得出现 apiKey、座位 token、DM token、hostToken、管理口令明文。
6. **无行为漂移**：标注为「重构」的步骤，前后同一组测试必须全部通过，且不修改任何现有断言（只允许新增）。

### 1.4 决策点（2026-09-26 用户已全部批准，按「最终决策」列执行）

全部决策已定，执行期间**不再向用户提问**。下表「最终决策」列即为授权范围，超出范围的动作仍然禁止。

| ID | 问题 | 最终决策（已批准） | 影响的步骤 |
|---|---|---|---|
| D1 | 当前 WIP 如何处理 | **C**（优化工作另开分支）。WIP 已由用户提交到 main（`39a81da`），因此不再需要 `wip/` 分支：从 main 切出 `opt/2026-09` 作为本计划唯一工作分支。**授权 agent 在 `opt/2026-09` 上提交**；main 不提交、不合并 | S0.1 及之后所有提交 |
| D2 | 开房策略 | `ROOM_CREATE_POLICY` 默认值：`NODE_ENV=production` 时为 `admin`，其余为 `open`；同时实现 `invite` 模式备用 | S3.1 |
| D3 | 每日 LLM token 预算 | `LLM_DAILY_TOKEN_BUDGET` 在 `.env.example` 中示例为 `2000000`；代码中未设置时视为 0（关闭），不改变现有部署的行为 | S3.2 |
| D4 | push 到 GitHub | 允许 push `opt/2026-09`（及验证 CI 用的 `ci-probe/*` 临时分支，验证后删除远端分支）。**禁止 push main、禁止 force push、禁止开 PR 合并到 main** | S1.3 及之后 |
| D5 | 真模型实机测试（R8） | 单次 ≤ 300,000 tokens，只在 P4、P7 结束时各跑 1 次。凭证来源见 §3.5「真模型模式」；拿不到凭证时 R8 记为 `SKIPPED(no-credentials)`，不阻塞 | R8 |
| D6 | 新增 dev 依赖 `@vitest/coverage-v8` | 允许，版本与已装 vitest 完全一致 | S0.4、S2.2 覆盖率 |
| D7 | Docker 与 pm2 | 并存：新增 Dockerfile + compose；`ecosystem.config.js` 保留（仅做 S8.4 规定的 `cwd` 修正） | S8.4 |

**除上表外，不得新增任何依赖**（`npx --yes` 临时运行的检查工具，如 madge、yaml-lint，不算新增依赖，但不得写进 package.json）。

---

## §2 标准门禁与全局验收指标

### 2.1 标准门禁 `G-std`（每步开始前、每个提交前都要跑）

```bash
npx tsc --noEmit
npx eslint src --max-warnings=0
npx vitest run
npm run -s script:validate -- seeds/*.json seeds/generated/*.json
```

通过条件（全部满足）：

| 项 | 判定 |
|---|---|
| tsc | 退出码 0，输出 0 行 `error TS` |
| eslint | 退出码 0（0 error、0 warning） |
| vitest | 0 failed；用例总数 ≥ 台账记录的上一步用例总数（不允许删测试换绿） |
| 种子校验 | 退出码 0，0 error |

S1.1 完成后，以上四条合并为 `npm run check`，此后用 `npm run check` 代替。

### 2.2 扩展门禁 `G-int`（涉及数据库行为的步骤：P2 之后的 S2.3+、P4、P5、S8.1、S8.2）

```bash
npm run test:int     # L3 集成测试（需 docker 的 jubensha_test 库，见 §3.4）
```

通过条件：退出码 0，0 failed，0 skipped（除非用例带 `// SKIP-REASON:` 注释并记入台账）。

### 2.3 实机门禁 `G-e2e`（每个阶段 P 结束时必跑；步骤注明时也要跑）

```bash
npm run e2e:up        # 起 :3100 独立实例 + jubensha_e2e 库（S2.5 提供）
npm run e2e:smoke     # R1–R5（无模型模式）
npm run e2e:down
```

通过条件：见 §3.5 各场景的「预期结果」，全部满足。

### 2.4 全局量化指标（计划结束时的目标值）

| 指标 | 基线 | 目标 | 采集方式 |
|---|---|---|---|
| tsc 错误 | 0 | 0（保持） | `npx tsc --noEmit` |
| eslint warning | 1 | 0 | `npx eslint src --max-warnings=0` |
| 有 L2 测试的 API 处理器 | 1/35 | 100%（35 个现有处理器 + 计划中新增的 health、stream-ticket） | §3.3 表逐项打勾 + `npm run test:api` |
| L2 用例数 | ~8 | ≥ 140 | vitest 报告 |
| L3 用例数 | 0 | ≥ 30 | vitest 报告 |
| `src/lib` + `src/app/api` 行覆盖率 | 未测 | ≥ 80% | `npm run test:cov`（D6） |
| `src/core/engine` 行覆盖率 | 在 S0.4 测得 | 不低于基线 | 同上 |
| 非测试代码 `console.*` | 27 | 0（`src/lib/log.ts` 除外） | grep |
| 非测试代码 `as unknown as` | 12 | ≤ 3，每处带注释说明原因 | grep |
| `engine.ts` 行数 | 1044 | ≤ 700 | `wc -l` |
| `handleActionInner` 函数体 | ~275 行 | ≤ 60 行（只做分发） | 人工核对 |
| `games/[id]/route.ts` 行数 | 185 | ≤ 70 | `wc -l` |
| SSE 稳态每连接每分钟 DB 查询 | 3 | 0 | L2 计数断言 + R6 |
| 非 LLM API p95 延迟（本机，e2e 库） | 未测 | < 300ms；DB 单查询 < 100ms | R7 |
| CI | 无 | PR/push 自动跑 `check` + `test:int` | GitHub Actions 运行记录 |
| npm audit high（运行时依赖链） | 0（3 个在 CLI 链路） | 0，且不新增 | `npm audit --omit=dev` |
| R1 无模型冒烟 | 手动、不稳定 | 连续 3 次通过 | `npm run e2e:smoke` |

---

## §3 测试体系

### 3.1 分层总览

| 层 | 名称 | 位置/命名 | 依赖 | 运行命令 | 何时运行 |
|---|---|---|---|---|---|
| L1 | 单元测试 | `src/**/*.test.ts`（现有） | 无，mock DB/LLM | `npx vitest run` | 每次提交 |
| L2 | API 路由测试 | `src/app/api/**/route.test.ts` | 无；mock `@/lib/db`、引擎、LLM | `npm run test:api` | 每次提交 |
| L3 | API 集成测试 | `src/**/*.int.test.ts` | docker PostgreSQL `jubensha_test`；LLM 一律 mock | `npm run test:int` | 涉及 DB 的步骤、CI |
| L4 | 实机测试 | `scripts/e2e/*.mjs` + 浏览器检查清单 | :3100 实例 + `jubensha_e2e` 库；默认无模型 | `npm run e2e:smoke` + 浏览器 | 每阶段结束、指定步骤 |

### 3.2 L2 API 路由测试：方法

- **写法**：参照现有 `src/app/api/games/[id]/events/route.test.ts`，直接 import 路由导出的 `GET/POST/...`，构造 `new Request(url, { method, headers, body })` 和 `{ params: Promise.resolve({...}) }` 调用，断言 `status` + JSON body。
- **公共夹具**：S2.1 新建 `src/test/api.ts`，提供：
  - `makeReq(method, path, { body?, headers?, query? })`
  - `ctx(params)`
  - `mockDb()`：返回按模型分组的 `vi.fn()` 集合，支持 `$transaction` 数组形式和回调形式
  - `adminHeaders()`：生成合法的 `x-admin-token`（测试内设置 `process.env.ADMIN_TOKEN`）
  - 常用行工厂：`roomRow()`、`seatRow()`、`gameRow()`、`scriptRow()`（剧本用 `seeds/examples/script-v2.example.json`）
- **环境**：每个文件 `beforeEach` 调 `resetRateLimits()`；需要生产模式分支时用 `vi.stubEnv("NODE_ENV", "production")`，并在 `afterEach` 调 `vi.unstubAllEnvs()`。
- **必须覆盖的维度**（每个处理器按适用性覆盖）：
  - (a) 正常路径
  - (b) 鉴权失败：无凭证 / 错凭证 / 他人凭证
  - (c) 参数校验：缺字段 / 类型错 / 超长 / 越界
  - (d) 资源不存在 → 404
  - (e) 业务冲突 → 400/409
  - (f) 限流 → 429 且带 `Retry-After`
  - (g) 未捕获异常 → 500 且 body 仅固定文案、不含异常 message
  - (h) 信息泄露：响应不含他人私有字段、token、apiKey 明文

### 3.3 L2 覆盖场景矩阵（35 个处理器）

「维度」列引用 §3.2 的 (a)–(h)。每个处理器至少覆盖列出的维度；「关键断言」为必须存在的断言。

| # | 处理器 | 维度 | 关键断言（预期结果） |
|---|---|---|---|
| A01 | `POST /api/admin/unlock` | a b c f? g | 正确口令 → 200 + `Set-Cookie: jbs_admin=...; HttpOnly; SameSite=Lax`；错口令 → 401 且无 Set-Cookie；生产环境未配 ADMIN_TOKEN → 500 固定文案 |
| A02 | `GET /api/admin/unlock` | a b | 带合法 cookie → `{admin:true}`；无 → `{admin:false}`；生产环境 + `Host: localhost` 且未开 TRUST_LOOPBACK → false |
| A03 | `GET /api/providers` | a b h | 非管理员 401；管理员返回列表，apiKey 仅掩码形式（`••••••••xxxx`），不含 `apiKeyCipher` |
| A04 | `POST /api/providers` | a b c h | baseUrl 为 `http://169.254.169.254` → 400；合法 → 201，DB 收到的是密文（不等于明文） |
| A05 | `PATCH /api/providers/[id]` | a b c d | 不存在 → 404；改 baseUrl 走 SSRF 守卫 |
| A06 | `DELETE /api/providers/[id]` | a b d | 非管理员 401；成功后 200 |
| A07 | `POST /api/providers/test` | a b c | 非管理员 401；元数据地址 400；LLM 客户端被 mock，不发真实网络请求 |
| A08 | `GET /api/bindings` | a b | 非管理员 401 |
| A09 | `PUT /api/bindings` | a b c | slot 不在枚举内 → 400；providerId 不存在 → 400/404 |
| A10 | `GET /api/settings/database` | a b h | 返回的连接串密码为 `****` |
| A11 | `POST /api/settings/database` | a b c | 非 `postgresql://` → 400；`pingDatabase` 被 mock |
| A12 | `PUT /api/settings/database` | a b c | 写配置只发生在管理员请求；`writeAppConfig` 被 mock，断言入参 |
| A13 | `GET /api/usage` | a b | 非管理员 401 |
| A14 | `GET /api/scripts` | a h | 返回列表不含 `content.truth`、不含 `designPackage` |
| A15 | `POST /api/scripts` | a b c | 非管理员 401；V1 文档自动迁移为 V2；非法 JSON → 400 |
| A16 | `GET /api/scripts/[id]` | a b d h | 非管理员拿不到 truth/私有卡（按现行规则核对后写断言） |
| A17 | `PATCH /api/scripts/[id]` | a b c d | 非管理员 401 |
| A18 | `DELETE /api/scripts/[id]` | a b d | 软删除：断言 `update({deleted:true})` 而非 `delete` |
| A19 | `POST /api/scripts/[id]` | a b d | 按实际语义（导出/复制等）核对后写断言 |
| A20 | `GET /api/scripts/[id]/meta` | a d h | 不含私有字段 |
| A21 | `POST /api/scripts/generate` | a b c | 非管理员 401；LLM mock |
| A22 | `POST /api/rooms` | a c d e f g | 座位数 < 3 或 > 8 → 400；剧本不存在 → 404；角色重复 → 400；第 6 次/分钟 → 429 + Retry-After；P2002 撞码重试后成功；返回 hostToken 为 32 位 hex；S3.1 后按 D2 增加鉴权用例 |
| A23 | `GET /api/rooms/[code]` | a d f h | 返回的座位不含任何 token；限流 429 |
| A24 | `PATCH /api/rooms/[code]` | a b c d e | 错 hostToken → 403；非大厅状态 → 400；改成 AI 座位后 token 被置 null |
| A25 | `POST /api/rooms/[code]/start` | a b d e | 错 hostToken → 403；已有对局 → 400/409；真人座位未入座 → 400；成功 → 201 + gameId，room 状态更新为 playing（引擎 mock） |
| A26 | `POST /api/rooms/join` | a c d e f | 同名歧义 → ambiguous；无 token 冒名 → taken；持旧 token → resume；满员 → full；并发抢座（`updateMany` count=0）→ 失败提示；第 11 次/分钟 → 429 |
| A27 | `POST /api/rooms/dm-join` | a b e | 非 humanDm 房 → 400；已被认领 → taken |
| A28 | `GET /api/games/[id]` | a b d h | 无/错 token → mySeat=null，`myCard`、`myClues`、`pendingAnswer`、`suggestions` 全为空；正确 token 只返回本人的 `myCard`；他人 `myCardV2` 恒 null；`quizResult` 仅 ENDED 返回；快照损坏 → 503；匿名请求不触发 `GameEngine.load` |
| A29 | `GET /api/games/[id]/events` | 已有 + h | 补充：DM 视角需 humanDm + dmToken；伪造 Last-Event-ID 降级为 0；观战者收不到 `seat:N` 与私聊 delta |
| A30 | `POST /api/games/[id]/actions` | a b c d f g | 错 token → 403；`text` 超长被截断（speak 800 / ask 200 等，断言截断发生在引擎层）；未知 type → 400；load 抛错 → 503；第 61 次/分钟 → 429 |
| A31 | `POST /api/games/[id]/dm-actions` | a b c | 非 DM → 401/403；`abort_game` 需 DM 凭证 |
| A32 | `GET /api/games/[id]/dm-actions` | a b h | 非 DM 拿不到 truth |
| A33 | `POST /api/tts` | a b c d f | 无凭证 → 401；非公开发言 → 404；非 AI 发言 → 404；文本 > 600 → 404；合成失败 → 502 且不泄露上游报文 |
| A34 | `GET /api/tts/[hash]` | a d c | hash 非法格式（含 `../`）→ 400/404，不读任意路径 |
| A35 | 所有处理器 | g | 用 `it.each` 批量：mock 让 db 首次调用抛 `Error("SECRET-DETAIL")`，断言 500 且 body 不含 `SECRET-DETAIL` |

新增的处理器（S6.2 的 `/api/health`）同样按本表补一行。

### 3.4 L3 API 集成测试：方法

- **数据库**：新增 `docker-compose.test.yml`，服务 `pg-test`（`postgres:16-alpine`，宿主端口 5433，库 `jubensha_test`，tmpfs 数据卷）。
- **配置**：新增 `vitest.int.config.ts`，只包含 `src/**/*.int.test.ts`，`pool: "forks"`，`fileParallelism: false`（共享一个库，串行执行）。`globalSetup` 做三件事：
  1. 检查 `DATABASE_URL` 包含 `jubensha_test`，否则直接失败退出（防误连）；
  2. `prisma migrate deploy`；
  3. 设置 `APP_CONFIG_PATH` 指向一个不存在的文件，避免读到 `local.app.json`（依赖 S1.2）。
- **清理**：每个文件 `beforeEach` 执行 `TRUNCATE ... RESTART IDENTITY CASCADE`（全部业务表）。
- **LLM**：`vi.mock("@/core/llm/client")`，返回固定台词；embedding 返回 null。
- **定时器**：引擎相关用例 `engine.clearTimers("")` 后手动 `tick()`，或 `vi.useFakeTimers()`。
- **覆盖场景**（每条 ≥ 1 个用例，编号在后续步骤中引用）：

| # | 场景 | 预期结果 |
|---|---|---|
| I01 | 建房 → join → start 全链路（真库） | rooms/seats/games/seat_states 行数正确；games.scriptSnapshot 与 hash 一致 |
| I02 | 同一房间并发两次 start | 恰好 1 个 201，另一个 400/409；games 行数 = 1 |
| I03 | 并发两人抢最后一个真人座位 | 恰好 1 人成功；seat.token 只写一次 |
| I04 | 房间码撞码（预插入同 code） | 重试后成功，code 不同 |
| I05 | `recordEvent` 事务（S4.2） | 注入 game.update 失败 → game_events 行数不变、总线未广播、内存 events 未增长 |
| I06 | 重启恢复：start → 推进到 DISCUSSION → 清空 registry → `GameEngine.load` | phase/round/heldClues 与内存一致；继续 tick 可推进 |
| I07 | 旧快照（v0 fixture）加载（S4.3） | 迁移后通过 zod 校验，`stateVersion` 为最新，可继续推进 |
| I08 | 租约（S4.2 前置的 S4.1）：两个引擎实例争同一局 | 只有 1 个获得租约；另一个 `drive=false`，不写事件 |
| I09 | 租约过期接管 | 持有者停止续租，超过 TTL 后另一实例接管，事件 seq 连续、无重复发言 |
| I10 | SSE 历史分页回放（S5.2），5,000 条事件 | 收到全部 5,000 条，按 seq 升序、无重复；单批查询 ≤ 500 条 |
| I11 | 预算熔断（S3.2） | usage_logs 当日合计 ≥ 预算 → chat 抛 `BudgetExceededError`，引擎走降级提示，不崩溃 |
| I12 | 数据保留脚本（S8.2）dry-run / apply | dry-run 不删任何行；apply 只删除「已结束且超过 N 天」的对局，级联删除事件 |
| I13 | CHECK 约束（S8.1） | 插入非法 `rooms.status` → 数据库报错 |

### 3.5 L4 实机测试：方法与场景

**环境（S2.5 提供脚本）：**

- 独立库 `jubensha_e2e`（复用 `docker-compose.test.yml` 的 `pg-test` 服务，另建一个库）。
- 独立实例：`npm run build` 后以 `PORT=3100 APP_CONFIG_PATH=./.e2e/app.json DATABASE_URL=...jubensha_e2e NODE_ENV=production ADMIN_TOKEN=e2e-admin-<随机> SECRET_MASTER_KEY=<随机>` 启动 `next start`，由 `scripts/e2e/up.mjs` 管理（写 pid 文件，`down.mjs` 负责杀进程并 drop 库）。
- 种子：`up.mjs` 在启动后用管理员口令调用 `POST /api/scripts` 导入 `seeds/sample-5p-cloudlanshan.json` 与 `seeds/generated/` 中 2 本（4 人本、6 人本各 1）。
- **无模型模式（默认）**：e2e 库不配置任何 binding，AI 发言按现有逻辑降级为提示，流程仍须闭环。零花费、结果可重复。
- **真模型模式（R8，按 D5 限额）**：凭证只从 agent 进程的环境变量读取：`E2E_LLM_PROTOCOL`（`openai_compatible`|`anthropic`）、`E2E_LLM_BASE_URL`、`E2E_LLM_API_KEY`、`E2E_LLM_MODEL`。脚本 `scripts/e2e/r8.mjs` 用管理员口令调用 `POST /api/providers` + `PUT /api/bindings`，把 dm、culprit、player 三个槽位绑定到该模型，并设 `LLM_DAILY_TOKEN_BUDGET=300000` 作为硬上限；只跑 1 局，结束后读 `/api/usage` 记录花费。环境变量缺失时 R8 记为 `SKIPPED(no-credentials)`。**严禁**从 `.env`、`local.*.json` 或用户数据库读取、解密任何已有的 provider 密钥。
- 所有 e2e 脚本启动时校验：`SMOKE_BASE` 端口不是 3000，否则拒绝运行（除非显式设 `E2E_ALLOW_3000=1`）。

**场景：**

| # | 场景 | 方法 | 预期结果（通过条件） |
|---|---|---|---|
| R1 | 无模型全流程冒烟 | `scripts/smoke-m3.mjs`（`SMOKE_BASE=http://127.0.0.1:3100`），5 人本 1 真人 + 4 AI | 15 分钟内到达 ENDED；`voteResult` 非空；输出里没有 `!! action failed`（「已经选过」除外）；退出码 0。**连续 3 次**通过 |
| R2 | 鉴权负向实机 | `scripts/e2e/auth.mjs`：错 token 发 action、观战 SSE、无口令访问管理接口、伪造 `Host: localhost` + `X-Forwarded-For: 127.0.0.1` 访问 `/api/providers` | 分别为 403、仅 public 事件、401、401 |
| R3 | SSE 断线续传 | `scripts/e2e/sse-resume.mjs`：对局中途断开 SSE，等待期间有新事件产生，带 `Last-Event-ID` 重连 | 重连后收到的事件 seq 严格递增、与断线前衔接、不重不漏（与 DB 中 seq 列表比对，差集为空） |
| R4 | 进程重启恢复 | 对局推进到 DISCUSSION 后 `down` 进程（保留库）→ `up` → 用同一座位 token 请求 `GET /api/games/[id]` 并继续 R1 剩余流程 | 恢复后 phase/round 与重启前一致；能继续推进到 ENDED；日志无未捕获异常 |
| R5 | 多实例单写者（S4.1 后启用） | 同库再起一个 :3101 实例，两个实例都用座位 token 触发懒恢复 | 同一局只有 1 个实例写事件（按 `game_events` 统计，每个回合的 speech 事件数与单实例一致，无重复发言）；另一个实例日志出现 `lease held by` |
| R6 | SSE 负载（S5.1 前后各测一次） | `scripts/e2e/sse-load.mjs`：50 个观战 SSE 连接保持 5 分钟；开启 Prisma query 日志计数（`DEBUG_PRISMA_QUERY_COUNT=1`，S6.1 提供） | S5.1 之前：基线约 150 次/分钟；之后：稳态 **0** 次/分钟（与连接数无关）；进程 RSS 增长 < 50MB |
| R7 | API 延迟 | `scripts/e2e/latency.mjs`：对 `GET /api/scripts`、`GET /api/rooms/[code]`、`GET /api/games/[id]`（带座位 token）、`POST actions`（skip 类）各请求 200 次 | p95 < 300ms，p99 < 500ms；Prisma 单查询耗时 p95 < 100ms（查询日志） |
| R8 | 真模型对局（D5 限额；无凭证则 SKIPPED） | R1 脚本 + 真实 binding，1 局 | 到达 ENDED；`system` 事件中「后台 AI 操作失败」= 0；usage_logs 总 token ≤ D5 上限；预算熔断未误触发 |
| R9 | 浏览器实机（UI） | 用浏览器自动化工具（内置 Browser 面板）打开 :3100，按下方清单执行，每项截图存到 `.e2e/screens/<步骤号>/` | 清单全部通过；控制台 0 条 error（CSP report-only 告警单独记录） |

**R9 浏览器检查清单**（桌面 1280×800 + 移动 375×812 各跑一遍）：

1. 首页、`/scripts`、`/scripts/[id]`、`/rooms/new`、`/settings` 可打开，无白屏，无横向滚动（移动端）。
2. `/settings`：未解锁时管理区显示「需要管理员」；输入 e2e 口令后解锁成功，provider 的 apiKey 以掩码显示。
3. 建房：选 5 人本，座位 1 真人 + 4 AI → 拿到房间码 → 另开一个标签页用昵称入座 → 房主开局 → 跳转 `/play/[id]`。
4. 对局页：READING 能点「读完」；SELF_INTRO 轮到真人时出现输入框并能发言，发言出现在 ChatFeed；SEARCH 能选地点、看到线索卡、做公开/私藏决策；DISCUSSION 能提问；VOTE 能选目标并引用公开材料；REVEAL/ENDED 能看到结算卡。
5. 刷新对局页：身份保持（localStorage），事件不重复显示，阶段一致。
6. 用另一个无痕上下文只带房间码打开对局页：看不到任何私有卡与私聊。
7. 截图对比：与上一阶段同名截图做人工比对，没有明显布局回退（记入台账）。

---

## §4 阶段与步骤

步骤字段说明：**目标**（要达到什么）/ **前置**（依赖的步骤与决策）/ **涉及范围**（文件）/ **输入** / **具体操作** / **输出** / **测试** / **验收标准**（全部满足才算 DONE）/ **回滚** / **风险**。

---

### P0 止血与基线（全部 P0，预计 0.5 天）

#### S0.1 建立工作分支

- **目标**：在干净的 `opt/2026-09` 分支上开展本计划，main 保持不动。
- **前置**：无。
- **涉及范围**：git 分支；`docs/optimization-plan-2026-09-26.md`（本计划，含 D1–D7 决策的更新版）。
- **输入**：`git status --short`、`git rev-parse main`。
- **具体操作**：
  1. 记录 `git rev-parse main`，写入台账作为基线提交（应为 `39a81da` 或之后的提交）。
  2. `git status --short`：预期只有本计划文件处于修改状态。如果还有其他改动（用户新写的），**不要 add 它们**；执行 `git switch -c` 时这些改动会随工作区一起带到新分支，保持原样、不提交。在台账中记录这些文件名，此后所有 `git add` 都必须避开它们。
  3. 安全检查：`git status --short` 中不得出现 `.env`、`local.app.json`、`local.init.json`、`local.llm.json`。
  4. `git switch -c opt/2026-09`。
  5. `git add -- docs/optimization-plan-2026-09-26.md`，提交 `docs(plan): 写入 D1–D7 决策，改为无人值守执行 [S0.1]`（附 Co-Authored-By 行）。
  6. `git push -u origin opt/2026-09`（失败按 §0.3 记为 push-pending）。
- **输出**：基线提交哈希、计划提交哈希，写入台账。
- **测试**：`npx vitest run` 通过。
- **验收标准**：
  1. `git branch --show-current` = `opt/2026-09`；
  2. `git status --short` 只剩第 2 步记录的「用户改动」（没有则为空）；
  3. main 的 HEAD 等于第 1 步记录的哈希；
  4. vitest 全部通过，用例数 ≥ 387。
- **回滚**：`git switch main`（opt 分支保留，不删除）。

#### S0.2 类型与 lint 归零

- **目标**：`G-std` 全绿，作为后续所有步骤的基线。
- **前置**：S0.1。
- **涉及范围**：`src/core/engine/flow.ts`（若复测时 tsc 又出现错误，也在本步修复，且只改出错的文件）。
- **具体操作**：
  - 复测 `npx tsc --noEmit`；2026-09-26 复测为 0 error，如有新增错误就按报错位置修正。
  - `flow.ts:18` 的未使用参数：确认调用方签名后，删参数或改用 `_` 前缀并加 eslint 允许注释——**优先删参数**，前提是所有调用点都同步调整；如调用方较多（> 3 处），改为 eslint 配置 `argsIgnorePattern: "^_"`，并在台账记录这一选择。
- **测试**：`G-std`。
- **验收标准**：tsc 0 error；eslint `--max-warnings=0` 退出码 0；vitest 通过数不变。
- **回滚**：revert 本提交。

#### S0.3 仓库卫生：`.env.example` 入库、取消误跟踪

- **目标**：新 clone 的仓库能按 README 启动；已忽略的目录不再被跟踪。
- **前置**：S0.1。
- **涉及范围**：`.gitignore`、`.env.example`、`.zcode/`。
- **具体操作**：
  1. 检查 `.env.example` 里每个值都是占位符（`change-me`、示例连接串），不是真实密钥；发现真实值就替换成占位符。
  2. `.gitignore` 在 `.env*` 下一行加 `!.env.example`。
  3. `git rm -r --cached .zcode`（只取消跟踪，不删本地文件）。
- **测试**：`git ls-files .env.example` 有输出；`git ls-files .zcode` 无输出；`test -f .zcode/plans/*.md` 仍存在。
- **验收标准**：以上三条全部成立；`git check-ignore .env` 仍然命中（`.env` 依旧被忽略）。
- **回滚**：revert。

#### S0.4 度量基线与台账建立

- **目标**：把 §1.1 的数字实测固化，作为后续对比的依据。
- **前置**：S0.2、S0.3。
- **涉及范围**：新建 `docs/optimization-progress.md`。
- **具体操作**：按 §6 模板建立台账；执行 §1.1 表中每条采集命令，填入「基线」列。如果 D6 已批准，先装 `@vitest/coverage-v8` 并测一次覆盖率基线（`npx vitest run --coverage`），记录 `src/lib`、`src/app/api`、`src/core/engine` 的行覆盖率。
- **输出**：台账文件。
- **验收标准**：台账包含 §1.1 全部指标的实测值，每个值旁附采集命令；覆盖率基线（若 D6 已批准）已记录。

**P0 阶段验收**：S0.1–S0.4 全部 DONE；`G-std` 绿；台账存在。（P0 暂不要求 `G-e2e`，实机环境在 P2 才建。）

---

### P1 质量门禁（P0，预计 0.5–1 天）

#### S1.1 npm 脚本统一

- **目标**：一条命令跑完门禁；测试分层可以单独执行。
- **前置**：P0。
- **涉及范围**：`package.json`、`vitest.config.ts`。
- **具体操作**：新增以下 scripts：
  - `"typecheck": "tsc --noEmit"`
  - `"lint": "eslint src --max-warnings=0"`（替换现有的 `eslint`）
  - `"validate:seeds": "tsx scripts/validate-script-v2.ts seeds/*.json seeds/generated/*.json"`（先确认 npm scripts 在 sh 下能展开通配符；不能的话改为在 validate 脚本里支持目录参数）
  - `"test:api": "vitest run src/app/api"`
  - `"check": "npm run typecheck && npm run lint && vitest run && npm run validate:seeds"`
  - `"test:cov": "vitest run --coverage"`（D6）
  - `vitest.config.ts` 的 `exclude` 加 `**/*.int.test.ts`（为 L3 预留）。
- **测试**：分别执行每个新脚本。
- **验收标准**：`npm run check` 退出码 0，耗时 < 120s；`npm run test:api` 只跑 `src/app/api` 下的测试（输出的文件列表可证明）；故意引入一个类型错误时 `npm run check` 退出码非 0（验证完即还原，不提交）。

#### S1.2 数据库配置可覆盖（测试隔离前提）

- **目标**：测试和 e2e 实例能确定地连到专用库，绝不误读 `local.app.json`。
- **前置**：S1.1。
- **涉及范围**：`src/lib/app-config.ts`、`src/lib/app-config.test.ts`。
- **具体操作**：`appConfigPath()` 改为 `process.env.APP_CONFIG_PATH ?? path.join(process.cwd(), APP_CONFIG_FILE)`。不做其他改动。
- **测试（L1）**：新增用例：
  - 设置 `APP_CONFIG_PATH` 指向临时文件时，读写都落在该文件；
  - 指向不存在的文件时，`resolveDatabaseUrl()` 回落到 `DATABASE_URL`，`source === "env"`。
- **验收标准**：新增 ≥ 2 个用例并通过；未设该环境变量时现有行为不变（现有 app-config 测试全过）；`.env.example` 增加 `APP_CONFIG_PATH` 的注释说明。

#### S1.3 CI（GitHub Actions）

- **目标**：每次 push 或 PR 自动跑门禁。
- **前置**：S1.1；在线验证需要 D4。
- **涉及范围**：新建 `.github/workflows/ci.yml`。
- **具体操作**：
  - job `check`：ubuntu-latest，Node 版本与本机 `node -v` 的大版本一致，`npm ci`，`npx prisma generate`，`npm run check`。
  - job `integration`（S2.3 完成后再启用；先写好并用 `if: false` 关闭）：`services.postgres`（postgres:16-alpine，库 `jubensha_test`），`DATABASE_URL` 指向它，执行 `npm run test:int`。
  - 触发条件：`push`（全部分支）、`pull_request`（main）。
  - 缓存：`actions/setup-node` 的 npm cache。
- **测试**：本地用 `act` 验证（如果没装就跳过）；D4 允许后 push 工作分支，观察运行结果。
- **验收标准**：
  1. workflow 的 YAML 语法合法（`npx --yes yaml-lint` 或 GitHub 界面无语法报错）；
  2. D4 允许时，线上运行 `check` job 绿，耗时 < 10 分钟，运行链接记入台账；
  3. 从 `opt/2026-09` 切出 `ci-probe/lint-fail`，提交一处 lint 错误并 push，CI 变红后执行 `git push origin --delete ci-probe/lint-fail` 并删除本地分支（这是唯一允许的远端分支删除）。push 不可用时，第 2、3 条标为 `push-pending`，不阻塞后续步骤。

#### S1.4 本地提交钩子（轻量，不引入依赖）

- **目标**：提交前自动跑快速门禁，减少把红代码推上去的机会。
- **前置**：S1.1。
- **涉及范围**：新建 `scripts/git-hooks/pre-commit`；`package.json` 增加 `"hooks:install": "git config core.hooksPath scripts/git-hooks"`。
- **具体操作**：pre-commit 执行 `npm run typecheck && npm run lint`（不跑全量测试，控制在 60s 内）。不自动安装，README 加一句说明。
- **验收标准**：执行 `hooks:install` 后，故意制造 lint 错误时 `git commit` 被拒；耗时 < 60s；未执行安装的人不受影响。

**P1 阶段验收**：`npm run check` 可用且为绿；CI `check` job 绿（push 失败时台账标 `push-pending`，不阻塞）；`APP_CONFIG_PATH` 生效。

---

### P2 测试基建（P0/P1，预计 2–3 天）

#### S2.1 L2 公共夹具

- **目标**：写 API 路由测试的样板代码 ≤ 10 行/文件。
- **前置**：P1。
- **涉及范围**：新建 `src/test/api.ts`、`src/test/fixtures.ts`；把现有 `events/route.test.ts` 改为使用新夹具（只改夹具用法，断言不动）。
- **具体操作**：实现 §3.2 列出的函数；`mockDb()` 需要支持 `vi.mock("@/lib/db", () => ({ db: mockDbInstance }))` 这种写法。
- **验收标准**：夹具本身有 ≥ 5 个 L1 用例；events 路由测试迁移后用例数和断言都不变且全部通过；新写一个处理器测试文件的 import 与 setup 不超过 10 行（用 A13 `/api/usage` 做示范）。

#### S2.2 L2 鉴权矩阵与全量路由测试

- **目标**：35 个处理器全部有 L2 测试，覆盖 §3.3 矩阵。
- **前置**：S2.1。
- **涉及范围**：`src/app/api/**/route.test.ts`（新建约 20 个文件）。
- **具体操作**：按 §3.3 逐行实现；分 4 个提交：管理面（A01–A13）、剧本（A14–A21）、房间（A22–A27）、对局与 TTS（A28–A35）。**写测试时发现的缺陷只记录，不在本步修复**（登记到台账「发现的缺陷」栏，由 S7.3 或专门的步骤处理），测试用 `it.fails` 标注，并在注释里写明缺陷编号。
  - 已知需要登记的缺陷：`GET /api/games/[id]` 的 token 取值顺序是 query 优先，与注释「header 优先」相反（登记为 BUG-01）。
- **测试**：`npm run test:api`。
- **验收标准**：
  1. §3.3 每一行都有对应的 `describe`，并在测试名里带编号（例：`describe("A22 POST /api/rooms")`）；
  2. `grep -c 'describe("A[0-9]' -r src/app/api` ≥ 35；
  3. L2 用例总数 ≥ 140；
  4. 全部通过（`it.fails` 标注的除外，且每个 `it.fails` 都对应台账里的一个缺陷编号）；
  5. `src/app/api` 行覆盖率 ≥ 80%（D6）；
  6. `npm run test:api` 耗时 < 30s。

#### S2.3 L3 集成测试基建

- **目标**：可以对真实 PostgreSQL 运行事务、约束、并发、恢复类测试。
- **前置**：S1.2。
- **涉及范围**：新建 `docker-compose.test.yml`、`vitest.int.config.ts`、`src/test/int-setup.ts`；`package.json` 增加 `"test:int": "vitest run -c vitest.int.config.ts"`、`"db:test:up": "docker compose -f docker-compose.test.yml up -d --wait"`、`"db:test:down": "docker compose -f docker-compose.test.yml down -v"`。
- **具体操作**：按 §3.4 实现。`globalSetup` 在 `DATABASE_URL` 不含 `jubensha_test` 时抛错。先实现 I01–I04、I06 这 5 个不依赖后续改造的用例。
- **测试**：`npm run db:test:up && npm run test:int && npm run db:test:down`。
- **验收标准**：
  1. I01–I04、I06 通过；
  2. 连续跑 3 次，结果一致（无偶发失败）；
  3. 故意把 `DATABASE_URL` 设成别的库名时，测试在连库之前就失败退出；
  4. 在 S1.3 的 CI 中启用 `integration` job 并变绿（D4）。

#### S2.4 引擎恢复与并发的 L3 补强

- **目标**：为 P4 的改造建立回归网。
- **前置**：S2.3。
- **涉及范围**：`src/core/engine/*.int.test.ts`。
- **具体操作**：
  - 为 I06 增加 3 个恢复点变体（SEARCH 中、VOTE 中、REVEAL→ENDED 之间）。
  - 新增用例：同一座位并发提交 2 个 `speak` 动作（`Promise.all`），断言只记录 1 条发言。
  - 新增用例：`handleAction` 与定时器 tick 交错执行，断言 `exclusive` 互斥下状态一致。
- **验收标准**：新增 ≥ 5 个用例并通过；不修改任何生产代码（发现缺陷按 S2.2 的规则登记）。

#### S2.5 L4 实机环境与脚本

- **目标**：一条命令起隔离实例，一条命令跑完 R1–R4。
- **前置**：S1.2、S2.3。
- **涉及范围**：新建 `scripts/e2e/{up,down,auth,sse-resume,run}.mjs`；改 `scripts/import-seeds.mjs`（BASE 读 `SEED_BASE` 环境变量，并支持 `x-admin-token`）；改 `scripts/smoke-m3.mjs`（启动时检查端口不是 3000）；`.gitignore` 加 `/.e2e/`；`package.json` 增加 `e2e:up`、`e2e:down`、`e2e:smoke`。
- **具体操作**：
  - `up.mjs`：确保 pg-test 在运行 → `CREATE DATABASE jubensha_e2e`（已存在则先 drop）→ `prisma migrate deploy` → 检查 `.next` 构建产物比 `src` 新，否则先 `npm run build` → 以 §3.5 的环境变量 spawn `next start -p 3100` → 轮询 `/api/scripts` 就绪（超时 60s）→ 导入 3 本种子。
  - `down.mjs`：按 pid 文件杀进程；`--keep-db` 时不 drop 库（R4 使用）。
  - `run.mjs`：依次执行 R1、R2、R3，任一失败即退出码 1，并打印失败场景的编号。
- **测试**：`npm run e2e:up && npm run e2e:smoke && npm run e2e:down`。
- **验收标准**：
  1. R1 连续 3 次通过，每次 < 15 分钟；
  2. R2、R3 通过；
  3. R4 手工执行通过（步骤写进 `scripts/e2e/README.md`）；
  4. 全程 :3000 上的用户进程不受影响（执行前后 `pm2 describe jubensha` 的 restart 计数不变）；
  5. `down` 之后 `jubensha_e2e` 库不存在（`--keep-db` 除外）。

#### S2.6 R9 浏览器实机首轮

- **目标**：建立 UI 的基线截图，确认现有 UI 流程可用。
- **前置**：S2.5。
- **涉及范围**：无代码改动；产出 `.e2e/screens/S2.6/`。
- **具体操作**：按 §3.5 的 R9 清单执行，桌面与移动各一遍。
- **验收标准**：清单 7 项全部通过或已登记为缺陷；截图 ≥ 20 张；控制台 error 数记入台账作为基线。

**P2 阶段验收**：`npm run check`、`npm run test:int`、`G-e2e`（R1–R4）全绿；L2 覆盖 35/35；台账「发现的缺陷」栏有完整登记。

---

### P3 安全与成本（P0/P2，预计 1–1.5 天）

#### S3.1 开房授权策略

- **目标**：按 D2 的选择，阻止未授权者创建会消耗 LLM 额度的房间。
- **前置**：D2、S2.2。
- **涉及范围**：`src/app/api/rooms/route.ts`、`src/app/api/rooms/[code]/route.ts`（PATCH 把座位改成 AI 时同样受控）、`src/app/rooms/new/page.tsx`（错误提示）、`.env.example`。
- **具体操作**：
  - 新增环境变量 `ROOM_CREATE_POLICY=open|admin|invite`。默认值：开发环境 `open`；生产环境按 D2（建议 `admin`）。
  - `admin`：请求中含 AI 座位时要求 `isAdminRequest(req)`，否则 403「创建含 AI 座位的房间需要管理员身份」。
  - `invite`：要求 body 带 `inviteCode`，用 `safeEqualString` 与 `ROOM_INVITE_CODE` 比较。
  - PATCH 改座位时，只要结果中出现 AI 座位，就执行同样的检查。
- **测试（L2）**：A22、A24 各新增 3 种策略 × {有权限, 无权限} 的用例；纯真人房在 `admin` 策略下仍可自由创建。
- **测试（L4）**：R2 增加一条：生产模式、未带口令创建含 AI 房间 → 403。
- **验收标准**：新增 ≥ 10 个用例并通过；三种策略的行为与上面描述完全一致；`open` 策略下 R1 仍然通过（e2e 默认使用 `admin` 策略时，smoke 需带管理员口令，脚本同步修改）。
- **风险**：会影响局域网开黑体验 → 默认值按 D2，并在 README「快速开始」写清楚。

#### S3.2 每日 LLM token 预算熔断

- **目标**：即使授权被绕过，单日花费也有上限。
- **前置**：D3、S2.3。
- **涉及范围**：`src/core/llm/client.ts`（`chat`、`chatStream`、`embedTexts` 的入口）、新建 `src/core/llm/budget.ts`、`src/app/settings/page.tsx`（用量看板显示今日已用 / 预算）。
- **具体操作**：
  - `budget.ts`：`assertWithinBudget()` 读取 `LLM_DAILY_TOKEN_BUDGET`（0 或未设表示关闭）；按「服务器本地时区的当天」对 `usage_logs.totalTokens` 求和，结果进程内缓存 60s；超过预算抛 `BudgetExceededError`。
  - 在三个入口的第一行调用。`BudgetExceededError` 沿用现有「未绑定模型」的降级路径（AI 发言降级为提示），不能让引擎卡住。
  - 超预算时记一条结构化日志（S6.1 之前先用 `console.warn`，S6.1 会统一替换）。
- **测试**：L1：预算为 0 时不查库；缓存 60s 内只查一次；超预算时抛错。L3：I11。
- **验收标准**：以上用例全部通过；预算关闭时 `chat` 路径的查询数与改动前相同（mock 计数断言）；超预算时 R1 式的对局仍然能走到 ENDED（在 L3 用例中模拟）。

#### S3.3 凭证比较统一为常量时间

- **目标**：所有座位、DM、房主 token 的比较统一走 `safeEqualString`，并修复 BUG-01。
- **前置**：S2.2。
- **涉及范围**：新建 `src/lib/credentials.ts`（`verifySeatToken(seats, index, token)`、`verifyDmToken(room, token)`、`verifyHostToken(room, token)`）；替换以下路由里的 `!==` 比较：`games/[id]`、`games/[id]/actions`、`games/[id]/events`（含心跳）、`games/[id]/dm-actions`、`tts`、`rooms/[code]`、`rooms/[code]/start`，以及 `src/lib/join.ts`。
- **具体操作**：纯替换，语义保持不变（空 token 一律视为不匹配）。同时修复 BUG-01：`games/[id]` 改为 header 优先、query 回退。
- **测试**：`credentials.ts` 的 L1 用例覆盖 null、空串、长度不同、正确四种情况；S2.2 中 BUG-01 对应的 `it.fails` 改为 `it` 并通过。
- **验收标准**：`grep -rnE 'token\s*!==|!==\s*.*[Tt]oken' src/app/api src/lib/join.ts` 输出为空；L2 全部通过；BUG-01 在台账中关闭。

#### S3.4 CSP 从 report-only 转为强制执行

- **目标**：生产环境强制执行 CSP。
- **前置**：S2.6（有 R9 基线）。
- **涉及范围**：`next.config.ts`。
- **具体操作**：生产环境使用 `Content-Security-Policy`（强制），去掉 `'unsafe-eval'`；开发环境保留 report-only（Next dev 需要 eval）。
- **测试**：R9 全量重跑（生产构建）。
- **验收标准**：R9 通过；控制台 CSP 违规 = 0；`curl -sI http://127.0.0.1:3100/ | grep -i content-security-policy` 输出的是强制头，且不含 `unsafe-eval`。
- **回滚**：如果 R9 出现违规且当天无法定位，恢复 report-only，并把违规资源登记到台账。

#### S3.5 SSE 凭证改用一次性票据

- **目标**：座位和 DM 的 token 不再出现在 SSE 的 URL（访问日志）里。
- **前置**：S3.3、S5.1。
- **涉及范围**：新建 `POST /api/games/[id]/stream-ticket`（凭 header 里的 token 换取 60s 有效、一次性的 ticket）；`events/route.ts` 接受 `?ticket=`；`src/lib/join.ts` 的 `gameEventsUrl`；`useGameStream.ts`。
- **具体操作**：ticket 存在进程内 Map（单实例前提，与租约一致），用后即删，TTL 60s；旧的 `token` query 参数保留一个版本作为兼容，并记录 deprecation 日志。
- **测试**：L2：ticket 过期、重复使用、跨局使用均被拒；A29 补充 ticket 用例。L4：R3 改用 ticket 后仍然通过。
- **验收标准**：以上用例通过；前端建连时 URL 中不再包含 `token=`（R9 在网络面板中核对）；兼容路径仍然可用。

**P3 阶段验收**：`check` + `test:int` + `G-e2e`（R1–R4，R2 包含新增项）全绿；R9 在 CSP 强制执行下通过。

---

### P4 引擎可靠性（P1，预计 3–4 天）

执行顺序：S4.3（版本化）→ S4.1（租约）→ S4.2（原子写）。先版本化，是因为后两步都会给快照或表加字段。

#### S4.3 GameState 版本化与 zod 校验

- **目标**：取代 `load()` 里越积越多的 `??=`；旧快照有可测试的迁移路径。
- **前置**：S2.4。
- **涉及范围**：新建 `src/core/engine/state-schema.ts`（zod schema）、`src/core/engine/state-migrate.ts`；`engine.ts` 的 `load()`；`state.ts` 的 `initialState`；新建 fixtures 目录 `src/core/engine/__fixtures__/state/`。
- **具体操作**：
  1. 在 `GameState` 中加 `stateVersion: number`；`initialState` 写入最新版本号 `CURRENT_STATE_VERSION = 1`。
  2. `migrateState(raw: unknown): GameState`：无 `stateVersion` 的视为 v0，v0→v1 就是把现在 `load()` 里全部 `??=` 和兼容清理逻辑原样搬过来；最后 `GameStateSchema.parse`。
  3. zod schema 对未知字段使用 `.passthrough()`，避免旧快照里的冗余字段导致 parse 失败。
  4. `load()` 中用 `migrateState(game.state)` 替换整段 `??=`；对「依赖 `Date.now()` 的过期清理」保持原有行为（迁移函数接收 `now` 参数）。
  5. fixtures：从 L3/L4 测试对局生成 ≥ 5 个 v0 快照（覆盖 READING、SEARCH、DISCUSSION、VOTE、ENDED），另外手工构造 1 个「最老格式」（去掉 `actionPlans`、`interactionChoices` 等后加的字段）。**不得从用户日常使用的库导出。**
  6. 以后新增状态字段的规则：版本号 +1，并新增一个迁移函数。把这条规则写进 `state-migrate.ts` 的文件头注释。
- **测试**：L1：每个 fixture 迁移后通过 parse，且与「旧 `load()` 逻辑」的结果深度相等（先把旧逻辑复制进测试作为对照，本步完成后删除该对照副本）；幂等性：`migrateState(migrateState(x))` 等于 `migrateState(x)`。L3：I07。
- **验收标准**：
  1. `load()` 中不再有任何 `state.xxx ??=`；
  2. 新增 L1 用例 ≥ 8 个并通过；I07 通过；
  3. R4 通过（用改动前产生的快照做恢复：先用 S0.4 时的 build 起 e2e 对局推进到 DISCUSSION，再换新 build 恢复）；
  4. `as unknown as GameState` 的数量减少（记录前后数字）。
- **回滚**：revert。数据层面无破坏：v1 快照被旧代码读取时，多出来的字段会被忽略。

#### S4.1 单写者租约

- **目标**：同一对局在任一时刻最多只有一个进程在驱动，从根上消除「双驱动」。
- **前置**：S4.3、S2.4。
- **涉及范围**：Prisma schema（`Game` 增加 `ownerId String?`、`leaseUntil DateTime?`）+ 新 migration；新建 `src/core/engine/lease.ts`；`engine.ts` 的 `load/start`、`schedule/scheduleBackground` 的入口；`registry.ts`。
- **具体操作**：
  1. 进程启动时生成 `INSTANCE_ID = randomUUID()`。
  2. `acquireLease(gameId)`：`updateMany({ where: { id, OR: [{ ownerId: null }, { leaseUntil: { lt: now } }, { ownerId: INSTANCE_ID }] }, data: { ownerId: INSTANCE_ID, leaseUntil: now + 30s } })`，`count === 1` 表示获得租约。
  3. 获得租约后，每 10s 续租一次（timer 要 `unref`）；续租失败（count=0）→ 进入「失去租约」处理：`clearTimers`、中止 `activeAbortController`、从 registry 移除、记录日志 `lease lost`。
  4. `load/start` 没拿到租约时：返回一个**只读**引擎（`drive=false`：不 tick、不 schedule；`handleAction` 返回 `{ ok:false, error:"对局由其他实例主持，请刷新" }`）。
  5. 正常终局驱逐或进程退出时（`SIGTERM` 处理）主动释放租约（`ownerId=null`）。
- **测试**：L1：租约状态机（获得 / 续租 / 丢失 / 释放）。L3：I08、I09。L4：R5。
- **验收标准**：
  1. I08、I09、R5 通过；
  2. 单实例场景下 R1 连续 3 次通过，且每局续租写入次数 ≈ 时长 / 10s（± 20%）；
  3. migration 可以在已有数据的库上执行（新字段可空）；
  4. `SIGTERM` 后 1s 内租约被释放（L3 模拟）。
- **风险**：续租 timer 被事件循环阻塞 → 租期 30s 是续租间隔的 3 倍，留出余量；失去租约时一定要停止写入，这一点必须有用例覆盖。

#### S4.2 事件与快照原子写

- **目标**：消除「事件已落库、快照未落库」的崩溃窗口。
- **前置**：S4.1。
- **涉及范围**：`src/core/engine/state.ts`（`appendEvent`）、`engine.ts`（`recordEvent`）；其余 84 个调用点**不需要改**。
- **具体操作**：
  1. `appendEvent(gameId, ev, snapshot?: GameState)`：传入 snapshot 时，使用 `db.$transaction([gameEvent.create, game.update({ state, phase, round })])`；事务提交成功之后才 `publish`。
  2. `recordEvent` 传入 `this.state`。
  3. 独立的 `persist()` 调用保持不变（冗余但无害）。
  4. 构造函数里「恢复已落事件、尚未落快照的幂等边界」的逻辑保留，并加注释说明 S4.2 之后理论上已不会触发，作为纵深防御保留。
  5. 测量：记录改动前后单次 `recordEvent` 的平均耗时，以及典型 state JSON 的字节数。
- **测试**：L3：I05；在 recordEvent 之后、persist 之前模拟崩溃（直接丢弃引擎并重新 load），断言恢复后的状态包含该事件对应的状态变化。L1：`publish` 必须在事务 resolve 之后调用（mock 调用顺序断言）。
- **验收标准**：
  1. I05 与崩溃恢复用例通过；
  2. `recordEvent` 平均耗时增加 < 20ms（本机 L3 测得），state JSON p95 < 200KB；
  3. R1 连续 3 次通过，R4 通过；
  4. 如果耗时超标：改为「仅对关键事件类型（clue/vote/phase/reveal/transfer/interaction）原子写」，并在台账记录这一偏差。

#### S4.4 线索持有单一数据源

- **目标**：`SeatState.data.clueIds` 与 `state.heldClues` 不再双写。
- **前置**：S4.2。
- **涉及范围**：`search-deal.ts` 的 `syncSeatClueIds`（2 个调用点）、`games/[id]/route.ts` 的 `myClues`。
- **具体操作**：以 `state.heldClues` 为唯一来源；`myClues` 改为从 state 读取；`syncSeatClueIds` 暂时保留写入（兼容旧前端和脚本），但标注 `@deprecated`，并在台账登记后续删除计划。**`seat_states` 表本步不删除。**
- **测试**：L2 A28：`myClues` 与 `state.heldClues[seat]` 一致；故意让 `seat_states` 的值与 state 不一致时，以 state 为准。
- **验收标准**：用例通过；R1 通过；R9 中线索栏显示正确。

**P4 阶段验收**：`check` + `test:int`（含 I05–I09）+ `G-e2e`（R1–R5）全绿；R8 真模型对局一次（D5）；台账记录租约和原子写的性能数据。

---

### P5 性能（P1/P2，预计 1.5–2 天）

#### S5.1 SSE 心跳去 DB 化

- **目标**：稳态下 SSE 连接不产生 DB 查询。
- **前置**：S3.3、S2.2。
- **涉及范围**：`events/route.ts`；`bus.ts`（新增消息类型 `revoke`）；`rooms/[code]` PATCH、`rooms/join`、`rooms/dm-join`（凭证变更点）。
- **具体操作**：
  1. 复核「对局开始后座位 token 不再变化」这一事实（grep 所有写 `token` 的地方）。
  2. 心跳只发 `: ping`，删除其中的 DB 查询。
  3. 凭证变更点在写库成功后 `publish(gameId, { kind: "revoke", seat?, dm? })`（大厅阶段还没有 gameId 时跳过）；SSE 收到与自身视角匹配的 revoke 后关闭连接。
  4. 对局 abort/ENDED 后的行为保持不变。
- **测试**：L2：心跳周期内 `db.game.findUnique` 调用次数 = 1（只有建连时那一次）——使用 fake timers 推进 5 分钟；收到 revoke 后流关闭，且不影响其他座位的连接。L4：R6 前后对比。
- **验收标准**：以上 L2 用例通过；R6 中稳态查询次数 = 0/min；revoke 在 L2 中 < 1 个 tick 内生效；R3 仍然通过。

#### S5.2 SSE 历史回放分页

- **目标**：大局首连时不一次性把全部事件载入内存。
- **前置**：S5.1、S2.3。
- **涉及范围**：`events/route.ts` 的历史回放段。
- **具体操作**：改为以 `seq > cursor` 为条件、每批 `take: 500` 的循环，直到不足一批；批与批之间检查 `closed`，已关闭就中止。去重与 pending 合并的逻辑不变。
- **测试**：L2：1,200 条事件时分 3 批查询，输出顺序与去重正确；中途 abort 后不再继续查询。L3：I10。
- **验收标准**：用例通过；R3 通过；I10 的内存峰值（`process.memoryUsage().heapUsed` 差值）比不分页实现低 ≥ 50%（在同一用例中对照测量）。

#### S5.3 模型绑定缓存

- **目标**：LLM 调用不再每次都查库和解密。
- **前置**：S2.2。
- **涉及范围**：`src/core/llm/client.ts` 的 `resolveBinding`；`bindings`、`providers`、`providers/[id]` 路由的写操作。
- **具体操作**：进程内 `Map<slot, { binding, at }>`，TTL 60s；上述路由写成功后调用 `invalidateBindingCache()`。同时修正 `resolveBinding` 中与行为不符的注释「沿 fallbackSlot 找」（登记为 BUG-02）：**只改注释，不改行为**；是否让未绑定的槽位走 fallback 属于功能变更，登记到台账，由用户决定。
- **测试**：L1：TTL 内只查一次；invalidate 后重新查询；provider 被禁用后，缓存失效之后生效。
- **验收标准**：用例通过；L2 中写路由都断言调用了 invalidate。

#### S5.4 运行期事件数组上限

- **目标**：长局中内存不会随事件数量无限增长。
- **前置**：S4.2。
- **涉及范围**：`engine.ts` 的 `recordEvent`；`engine.events` 的 19 个读取点。
- **具体操作**：
  1. 先逐个审计 19 个读取点，按「只需近期事件 / 需要全局历史」分类，结果写入台账。
  2. 需要全局历史的读取点，改为查询 state 中已有的字段，或改为查 DB；无法改的就在本步停下，标 NEEDS-DECISION。
  3. 全部为「近期」类后，`recordEvent` 在 `events.length > 1500` 时截断到最近 1200 条。
- **测试**：L1：模拟 3,000 条事件后，AI 上下文构造仍然正常（摘要层覆盖早期事件）；幂等检查不受影响。L4：R1。
- **验收标准**：审计表完整；用例通过；R1 连续 3 次通过；R8（若执行）中 AI 发言质量无明显回退（人工抽查 5 条，记入台账）。
- **风险**：这一步最容易造成隐性行为漂移，所以审计必须先于改动；审计若发现 > 3 个「需要全局历史」的读取点，就推迟本步。

#### S5.5 延迟基线与预算核对

- **目标**：非 LLM API 满足 §2.4 的延迟指标。
- **前置**：S5.1–S5.3。
- **涉及范围**：新建 `scripts/e2e/latency.mjs`。
- **具体操作**：执行 R7；超标的接口用 Prisma 查询日志定位；每个优化单独提交（例如加索引走 migration、减少 include）。
- **验收标准**：R7 通过；每个优化提交在台账中都有前后对比数据。

**P5 阶段验收**：`check` + `test:int` + `G-e2e` 全绿；R6、R7 达标；台账有前后对比。

---

### P6 可观测性（P1，预计 1–1.5 天）

#### S6.1 结构化日志

- **目标**：日志可按对局检索，且不含任何敏感信息。
- **前置**：P1。
- **涉及范围**：新建 `src/lib/log.ts`；替换非测试代码中的 27 处 `console.*`。
- **具体操作**：
  - `log.info|warn|error(msg, fields?)`，输出单行 JSON：`{ts, level, msg, gameId?, phase?, round?, requestId?, ...}`。开发环境可以用 `LOG_FORMAT=pretty` 输出人类可读格式。
  - 内置脱敏：字段名匹配 `/token|apiKey|password|secret|cipher/i` 的值一律替换为 `"[redacted]"`；字符串值中出现 `sk-` 前缀（长度 ≥ 20）的片段替换为 `[redacted]`。
  - `withRoute` 为每个请求生成 `requestId`，写入 500 日志。
  - `DEBUG_PRISMA_QUERY_COUNT=1` 时，在 PrismaClient 上挂 `$on("query")` 计数，每 60s 输出一行 `{msg:"prisma.qpm", count}`（供 R6 使用）。
- **测试**：L1：输出格式；脱敏（覆盖字段名和值两种）；级别过滤。
- **验收标准**：非测试代码 `console.*` 数量为 0（`log.ts` 除外）；脱敏用例 ≥ 6 个并通过；R1 运行期间日志 `grep -E 'sk-[A-Za-z0-9]{16}|token":"[0-9a-f]{32}'` 无命中。

#### S6.2 健康检查接口

- **目标**：pm2、反向代理、e2e 脚本可以探活，并能发现卡住的对局。
- **前置**：S6.1、S4.1。
- **涉及范围**：新建 `src/app/api/health/route.ts`。
- **具体操作**：
  - 匿名访问：`{ ok, db: "up"|"down", uptimeSec }`，DB ping 超时 1s；DB 不可用时返回 503。
  - 管理员访问额外返回：`{ engines: 常驻引擎数, leasesHeld: 本实例持有的租约数, oldestStuckPhaseSec: 所有常驻引擎中「距上次事件」的最大秒数, budget: {used, limit} }`。
  - 不返回连接串、库名、版本号等信息。
- **测试**：L2：补充 A36 行（匿名 / 管理员 / DB down 三种情况；断言匿名响应只有 3 个键）。
- **验收标准**：用例通过；`e2e/up.mjs` 改为用 `/api/health` 判断就绪；p95 < 50ms（R7 中加测）。

#### S6.3 卡局告警

- **目标**：对局卡住时日志里能看到。
- **前置**：S6.2。
- **涉及范围**：`registry.ts`（新增一个 60s 的巡检 timer，`unref`）。
- **具体操作**：巡检所有常驻引擎，如果 `phase` 不是 ENDED，没有 `turnInFlight`，没有等待中的真人截止时间，并且距上次事件已超过 5 分钟，就输出 `log.warn("engine.stuck", {gameId, phase, round, idleSec})`，每局每 15 分钟最多报一次。
- **测试**：L1（fake timers）：满足条件时告警；有真人截止时间时不告警；有节流。
- **验收标准**：用例通过；R1 全程无 stuck 告警。

**P6 阶段验收**：`check` + `test:int` + `G-e2e` 全绿；`console.*` 为 0；health 接口已接入 e2e 脚本。

---

### P7 可维护性重构（P1，预计 2–3 天）

整个阶段都是**纯搬移优先**：先把代码原样搬走（行为零变化），再在后续的独立提交里整理。

#### S7.1 拆分 `handleActionInner` / `handleDmActionInner`

- **目标**：`engine.ts` ≤ 700 行；动作处理器可以独立测试。
- **前置**：P2（L2/L3 回归网）、S4.2。
- **涉及范围**：`engine.ts`；新建 `src/core/engine/actions/{index,player,dm}.ts`（或按领域拆成 speak/search/vote/social/skill/dm 多个文件，单文件 ≤ 250 行）。
- **具体操作**：
  1. 提交 1（纯搬移）：每个 `case` 的函数体原样搬成 `(e: GameEngine, seatIndex, action) => Promise<Result>`，放进 `const PLAYER_ACTIONS: Record<GameAction["type"], Handler>`；`handleActionInner` 只剩查表加兜底。DM 动作同样处理。
  2. 提交 2：私有成员如需被 actions 模块访问，改为 internal（沿用现有 `e: GameEngine` 形态），不新增 public API。
  3. 保持「只有 type-only 依赖 engine.ts」的约束。
- **测试**：全量 `check` + `test:int`；另为每个动作处理器新增 ≥ 1 个 L1 用例（13 个玩家动作 + 7 个 DM 动作）。
- **验收标准**：
  1. `wc -l src/core/engine/engine.ts` ≤ 700；
  2. `handleActionInner` 和 `handleDmActionInner` 各 ≤ 30 行；
  3. 提交 1 前后所有测试的名称与结果完全一致（`vitest run --reporter=json` 前后对比，passed 集合相等）；
  4. 新增 ≥ 20 个 L1 用例；
  5. 用 `npx madge --circular src/core/engine`（临时 npx，不加依赖）检查，无运行时循环依赖；
  6. `G-e2e` 通过。

#### S7.2 抽取座位视图投影

- **目标**：`GET /api/games/[id]` 的防泄露投影可以单独做单元测试。
- **前置**：S2.2（A28）、S4.4。
- **涉及范围**：新建 `src/core/engine/seat-view.ts`（`buildSeatView({ game, doc, runtimeState, seatStates, mySeat })`）；路由只负责取数、鉴权和调用。
- **具体操作**：提交 1 纯搬移；提交 2 为投影函数补测试。
- **测试（L1）**：信息泄露专项 ≥ 12 个用例：观战者看不到 `myCard`/`myClues`/`pendingAnswer`/`suggestions`/`openWhispers`/`skills`；A 座位看不到 B 座位的 `myCardV2`；`stages` 只包含已解锁的幕；`quiz` 不含正确选项；`quizResult` 只在 ENDED 返回；`interactionBeats` 只包含 public；`flow` 不外泄 truth 相关字段。
- **验收标准**：路由文件 ≤ 70 行；A28 全部通过且断言未改动；新增 L1 ≥ 12 个用例并通过；R9 第 6 项（无痕观战）通过。

#### S7.3 Json 边界类型收口与缺陷清理

- **目标**：`as unknown as` ≤ 3 处；台账中登记的缺陷全部关闭或已转交用户决策。
- **前置**：S4.3、S7.2。
- **涉及范围**：12 处 cast 所在文件；台账「发现的缺陷」栏中的所有条目。
- **具体操作**：Json 列的读取统一经过 zod parse（剧本走现有的 `parseScriptForRuntime`，state 走 `migrateState`，seat 数据新增一个小 schema）；每个缺陷单独一个 `fix:` 提交，并把对应的 `it.fails` 改为 `it`。
- **验收标准**：cast 数 ≤ 3，且每处都有注释说明原因；`grep -rn 'it.fails' src` 为空，或剩余条目都在台账中标记为「用户决策」；`check` 全绿。

**P7 阶段验收**：`check` + `test:int` + `G-e2e` + R9 全绿；R8 真模型对局一次（D5），结果与 P4 那次对比无回退（到达 ENDED；失败事件数不增加）。

---

### P8 数据、依赖、部署、文档（P2，预计 2 天）

#### S8.1 字符串枚举的数据库约束

- **目标**：非法的状态值在数据库这一层就被拒绝。
- **前置**：S2.3。
- **涉及范围**：新 migration（raw SQL `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)`）；`prisma/schema.prisma` 中对应字段的注释。
- **具体操作**：只对取值已经稳定的字段加约束：`rooms.status`、`seats.kind`、`games.status`、`games.phase`、`ai_providers.protocol`、`scripts.source`、`scripts.difficulty`。加约束前先用 SQL 检查 e2e 库和测试库里的现存值都合法，并在 migration 注释中写明「上线前需在目标库执行同样的检查 SQL」。**不在用户库上执行。**
- **测试**：L3：I13（每个约束各一条非法插入用例）。
- **验收标准**：I13 通过；`prisma migrate deploy` 在空库和 e2e 库上都成功；R1 通过。

#### S8.2 数据保留脚本

- **目标**：只追加的表有可控的清理手段。
- **前置**：S2.3。
- **涉及范围**：新建 `scripts/retention.ts`；`package.json` 增加 `"db:retention"`。
- **具体操作**：参数 `--days N`（默认 90）、`--apply`（默认 dry-run）；清理「已结束或已中止、且 `endedAt` 早于 N 天」的对局（级联删除 events、seat_states、votes、private_messages、event_vectors），以及早于 N 天的 `usage_logs` 和 `jev_shadow_logs`。执行前打印每张表将删除的行数。脚本启动时打印目标库（密码掩码），并要求 `--apply` 与 `--confirm <库名>` 同时提供才真正删除。
- **测试**：L3：I12。
- **验收标准**：I12 通过；dry-run 在任何情况下都不删除数据（用例覆盖）；缺少 `--confirm` 时 `--apply` 拒绝执行。

#### S8.3 依赖补丁升级

- **目标**：拿到同一大版本内的修复，不引入破坏性变更。
- **前置**：P7。
- **涉及范围**：`package.json`、`package-lock.json`。
- **具体操作**：`npm update ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/openai-compatible @types/react @types/react-dom`（只在 wanted 范围内）；Prisma 7、eslint 10、@types/node 大版本只写评估记录到台账，不执行升级。
- **测试**：`check` + `test:int` + `G-e2e` + R8（D5，LLM SDK 升级后必须跑）。
- **验收标准**：以上全部通过；`npm audit --omit=dev` 的 high 数量不增加；lockfile diff 只涉及目标包及其子依赖。
- **回滚**：`git checkout <前一提交> -- package.json package-lock.json && npm ci`。

#### S8.4 Docker Compose 部署

- **目标**：部署可复现，迁移自动执行。
- **前置**：D7、S6.2。
- **涉及范围**：新建 `Dockerfile`（多阶段构建，基于 Next standalone 输出；如需改 `next.config.ts` 的 `output: "standalone"`，先确认对 pm2 部署无影响）、`docker-compose.yml`（app + postgres + 命名卷）、`.dockerignore`、`docs/deployment-docker.md`。`ecosystem.config.js` 中硬编码的 `cwd` 改为 `__dirname`。
- **具体操作**：容器启动命令为 `prisma migrate deploy && node server.js`；healthcheck 使用 `/api/health`；`SECRET_MASTER_KEY`、`ADMIN_TOKEN` 通过 env_file 传入；`local.app.json` 不打进镜像。
- **测试**：`docker compose up -d` → 在容器内导入种子 → `SMOKE_BASE` 指向容器端口，执行 R1。
- **验收标准**：R1 通过；镜像 < 400MB；`docker compose down && docker compose up -d` 之后数据仍在（卷持久化）；`docker history` 和镜像内文件中都不含 `.env`、`local.*.json`（用 `docker run --rm <img> ls -la` 核对）。

#### S8.5 文档索引与 ADR

- **目标**：计划、审查、决策类文档可检索，并标明是否仍然有效。
- **前置**：无（可以随时穿插执行）。
- **涉及范围**：新建 `docs/README.md`（索引）、`docs/adr/0001-单写者租约.md`、`0002-状态版本化.md`、`0003-事件快照原子写.md`、`0004-开房授权与预算熔断.md`；README 的「测试」一节更新为 L1–L4 的命令。
- **验收标准**：`docs/` 下每个 .md 文件都在索引中出现，并标注状态（有效 / 已完成 / 已作废）；每篇 ADR 包含背景、决策、备选方案、后果四节；README 中的命令逐条可以执行（抽查）。

**P8 阶段验收**：`check` + `test:int` + `G-e2e` 全绿；Docker 部署下 R1 通过。

---

## §5 整体验收（计划完成判定）

同时满足以下全部条件，才判定本计划完成：

1. **步骤**：§4 中全部 39 步的状态为 `DONE`；任何 `BLOCKED` 或 `NEEDS-DECISION` 都必须已由用户明确接受为「本期不做」，并在台账中留有记录。
2. **门禁**：在最终提交上 `npm run check`、`npm run test:int` 退出码均为 0；CI 最近一次运行为绿（D4）。
3. **指标**：§2.4 表中每一项都达到目标值，且台账中有实测证据。
4. **实机**：R1 连续 3 次通过；R2–R7 通过；R9 桌面与移动均通过；R8（D5）在 P4、P7 结束时各通过一次；无凭证时记为 `SKIPPED(no-credentials)`，不视为未通过，但要写进最终报告。
5. **不变式**：§1.3 的 6 条不变式在最终代码上逐条核对并记录：
   - 防火墙：`grep` 确认 AI prompt 的构造只从 `context.ts` 进入；
   - 前缀缓存：抽查 1 局中同一座位多次调用的 system 哈希相同；
   - 旧档兼容：I07 通过；
   - SSE 三处一致：新增的 `revoke` 不进入事件流（它是总线控制消息，不是事件），这一点需要确认；
   - 错误不外泄：A35 通过；
   - 无行为漂移：P7 的 JSON 报告对比通过。
6. **安全**：R2 全部通过；日志脱敏检查无命中；`npm audit --omit=dev` 的 high 不多于基线。
7. **文档**：台账完整；`docs/README.md` 与 ADR 齐全；README 已更新。

---

## §6 进度台账模板（`docs/optimization-progress.md`）

```markdown
# 优化计划进度台账

计划：docs/optimization-plan-2026-09-26.md
工作分支：<branch>　　基线提交：<hash>

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

## 指标看板
| 指标 | 基线 | 当前 | 目标 | 最近更新步骤 |
|---|---|---|---|---|
| tsc 错误 | 0 | | 0 | |
| L2 覆盖处理器 | 1/35 | | 35/35 | |
| ...（§2.4 全部指标） | | | | |

## 步骤状态
| 步骤 | 状态 | 提交 | 开始 | 完成 | 验收证据摘要 | 偏差 |
|---|---|---|---|---|---|---|
| S0.1 | TODO / DOING / DONE / BLOCKED / NEEDS-DECISION | | | | | |

## 验收证据（每步一节）
### S0.2
- `npx tsc --noEmit` → 0 error（输出末行：…）
- `npx eslint src --max-warnings=0` → exit 0
- vitest：55 files / 387 passed

## 发现的缺陷
| 编号 | 发现于 | 描述 | 复现测试 | 状态 | 关闭提交 |
|---|---|---|---|---|---|
| BUG-01 | 审查 | games/[id] token 取值 query 优先，与注释相反 | A28 it.fails | OPEN | |
| BUG-02 | 审查 | resolveBinding 注释称沿 fallback 查找，实际直接抛错 | — | OPEN | |

## 实机测试记录
| 日期 | 阶段 | 场景 | 结果 | 耗时 | 证据路径 |
|---|---|---|---|---|---|
```

---

## 附：步骤依赖速查

```
S0.1 → S0.2, S0.3 → S0.4 → S1.1 → S1.2, S1.3, S1.4
S1.1 → S2.1 → S2.2 ─┬→ S3.1(D2), S3.3 → S3.5
S1.2 → S2.3 → S2.4 ─┤   S3.2(D3)
          S2.5 → S2.6 → S3.4
S2.4 → S4.3 → S4.1 → S4.2 → S4.4, S5.4
S3.3 + S2.2 → S5.1 → S5.2 ;  S2.2 → S5.3 ;  S5.1–S5.3 → S5.5
P1 → S6.1 → S6.2(需 S4.1) → S6.3
P2 + S4.2 → S7.1 ;  S2.2 + S4.4 → S7.2 → S7.3(需 S4.3)
S2.3 → S8.1, S8.2 ;  P7 → S8.3 ;  D7 + S6.2 → S8.4 ;  S8.5 可随时穿插
```

建议执行顺序：P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8。P6 的 S6.1 可以提前到 P2 之后执行，这样 R6 的查询计数能更早可用。
