# 剧本杀 · AI 演绎

网页版剧本杀游戏：**真人玩家 + AI 玩家混合对局**。AI 主持人（DM）控场，AI 玩家会读本、搜证、圆桌对线、隐瞒自己的秘密；凑不齐人时由 AI 补位，随时开局。

## 功能

- **房间制对局**：创建房间 → 选剧本 → 每个座位配置真人或 AI → 凭房间码入座 → 开局
- **完整流程**：读本 → 自我介绍 → 搜证（线索公开/私藏）→ 圆桌讨论（可插话、可私聊）→ 投票 → 真相复盘
- **信息防火墙**：AI 玩家只看得到公开事件流 + 自己的角色卡；全局真相仅 DM 可见；发言经泄露检测，防止 AI 剧透
- **多模型调度**：DM / 凶手 / 普通 AI 玩家 / 剧本生成 / TTS 分槽位绑定不同模型（凶手与 DM 建议用强模型），支持故障自动降级
- **剧本管理**：结构化 Schema（Zod 校验 + 逻辑校验器）、JSON 导入导出、AI 两阶段生成原创剧本
- **用量记账**：每次 LLM 调用按 Provider/模型/用途记账，设置页可看板
- **TTS 语音**：AI 发言可点击播放（OpenAI `/audio/speech` 兼容协议），本地文件缓存

## 技术栈

Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL + Prisma · Vercel AI SDK（OpenAI 兼容 / Anthropic）· Tailwind CSS · Vitest · SSE 实时推送（事件溯源，断线续传）

## 快速开始

```bash
# 1. 准备 PostgreSQL（本机 Docker，或直接用远端实例）
docker run -d --name jbs-pg -e POSTGRES_PASSWORD=jubensha -e POSTGRES_DB=jubensha -p 5432:5432 -v jbs_pgdata:/var/lib/postgresql/data postgres:16-alpine
# 远端库也可稍后在「设置 → 数据库」填写连接串（写入 local.app.json，优先于 .env）
# 换库初始化：npm run db:deploy && npm run db:import（需先在旧库 npm run db:export）

# 2. 安装依赖 + 建表
npm install
npm run db:migrate

# 3. 配置密钥：复制 .env.example 到 .env，设置 SECRET_MASTER_KEY（加密 API Key；生产环境还需 ADMIN_TOKEN 或管理会话）

# 4. 启动
npm run dev
```

打开 http://localhost:3000 后：

1. **设置 → 数据库**：填写本机或远端 `postgresql://…` 连接串，测试并保存（空库再执行 `npm run db:deploy`）
2. **设置 → AI 接入**：添加 Provider（DeepSeek / 智谱 / Qwen / Moonshot / OpenAI / Ollama 等，OpenAI 兼容协议一键填模板），测试连通性
3. **设置 → 模型绑定**：为 `DM 主持人`、`凶手玩家`、`普通 AI 玩家` 绑定模型（必配）；`剧本生成`、`语音合成` 按需
4. **剧本库**：内置原创样例本《云澜山庄的雪夜》（5 人本格）在 `seeds/` 下，可通过「导入 JSON」入库；也可用「AI 生成剧本」
5. **开房间**：选剧本 → 座位配置（AI / 真人）→ 创建 → 分享房间码给朋友入座 → 开始游戏

## 剧本 Schema

核心契约见 `src/core/script/v2/schema.ts`（V2）。一个剧本文档包含：

- `meta`：标题、人数、时长、难度、标签
- `background[]`：公开背景内容块（全员可见）
- `characters[]`：`publicProfile` + `privateCard`（背景、秘密、目标、个人时间线、已知情报、人设、`isCulprit`）
- `locations[]` / `clues[]`：地点对象与线索卡（`locationId` 引用；`auto_public` / `manual_public` / `keep_private`）
- `truth`（仅 DM 可见）：真凶、手法、时间线、证据链、复盘底稿
- `flow`：各阶段轮数、是否开私聊

运行时与存储以 V2 为准（`src/core/script/v2/`）。逻辑校验器（`validateScriptV2`）检查真凶一致性、线索地点、证据链等，error 级问题会阻止开局。

### V1 → V2 迁移

种子剧本已经是 V2。导入接口遇到 V1 会自动转换成 V2 再入库。文件转换工具仍可用于散落的旧 JSON：

```bash
# 只检查迁移结果，不写文件
npm run script:migrate -- seeds/fixtures/script-v1.sample.json

# 生成一个 V2 副本；目标文件已存在时必须显式加 --force
npm run script:migrate -- seeds/fixtures/script-v1.sample.json --out /tmp/v1-to-v2.json
npm run script:validate -- /tmp/v1-to-v2.json

# 把数据库里尚未升级的剧本回写成 V2
npm run script:migrate-db
npm run script:migrate-db -- --write
```

迁移 warning 需要人工复核：无法识别的非 `HH:mm` 时间、没有独立动机的旧文本、关键证据无法唯一映射到线索 ID。V1 schema 只留给转换器，不再作为运行时契约。

## 测试

```bash
npm test          # Vitest：剧本校验 / 防火墙 / 输出守卫 单测
node scripts/smoke-m3.mjs   # 端到端冒烟：1 真人 + 4 AI 走完全场（需 dev server 运行中；未配模型时 AI 发言降级为提示，流程仍应闭环）
```

## 目录结构

```
src/core/script/    剧本 Schema + 逻辑校验器
src/core/llm/       LLM 客户端（槽位绑定 / 重试 / 降级 / 用量记账）
src/core/tts/       TTS 合成 + 缓存
src/core/engine/    游戏引擎：状态机、发言调度、事件溯源（game_events append-only）
src/core/agents/    DM / 玩家智能体、信息防火墙（context.ts 唯一取数入口）、输出守卫
src/app/api/        REST + SSE 接口
src/app/            页面：剧本库 / 设置 / 房间 / 对局
seeds/              内置样例剧本
```

## 版权说明

内置与 AI 生成的剧本均为原创内容。外部导入功能请仅用于**自创或已获授权**的剧本；商用剧本受版权保护。

## 已知限制（MVP）

- 单实例部署（引擎状态在内存 + DB 快照，重启后自动恢复对局，但不支持多副本）
- 私聊仅真人发起（AI 不会主动发起私聊）
- 真人回合 3 分钟无操作自动跳过；搜证公开决策超时自动私藏
- TTS 依赖 OpenAI 兼容 `/audio/speech` 协议的服务商
