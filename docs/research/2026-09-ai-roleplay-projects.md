# AI 酒馆与角色扮演项目实现调研（2026-09-15）

本报告以官方仓库、官方文档、固定提交源码为证据，供 `jubensha` 的工程优化使用。它补充已有 `docs/ai-roleplay-research-2026-09.md`，不把旧文档里的实施记录当作本轮代码审计结果。未运行这些项目、没有用户规模或留存数据，没有做同模型对照体验实验，因此下文的“可借鉴”均为工程推断，不是质量提升已经得到实验证明。

## 1. 样本与热度口径

2026-09-15 通过 GitHub REST API 读取 stars、forks、pushed_at，通过默认分支最新 commit 固定源码。数值是当日快照、持续变化；stars 代表开发者关注度，不等于日活、付费规模或角色扮演质量。选择 SillyTavern 为高关注度主样本、RisuAI 为记忆与模板差异样本、KoboldCpp/Lite 为本地推理样本、Agnai 为多人架构样本；增加 AI Dungeon 作为闭源产品文档对照。

| 项目 | stars / forks | 仓库 pushed_at（UTC） | 定位和边界 |
| --- | --- | --- | --- |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 33,383 / 6,291 | 2026-09-14 19:16:18 | 自托管 RP 前端，非模型；主样本 |
| [RisuAI](https://github.com/kwaroran/RisuAI) | 1,680 / 349 | 2026-09-10 11:51:53 | Web/Tauri 角色聊天、模板和多代记忆 |
| [KoboldCpp](https://github.com/LostRuins/koboldcpp) | 11,712 / 766 | 2026-09-15 10:34:44 | GGUF 本地推理服务，附带 Lite |
| [KoboldAI Lite](https://github.com/LostRuins/lite.koboldai.net) | 202 / 100 | 2026-09-13 15:14:58 | 可独立使用的轻前端；不要把 Cpp stars 算作 Lite 活跃用户 |
| [Agnai](https://github.com/agnaistic/agnai) | 782 / 150 | 2026-06-15 05:01:37 | 多用户、多 bot 聊天；近期提交弱于前三者 |
| [AI Dungeon](https://help.aidungeon.com/faq/the-memory-system) | 不适用 | 不适用 | 产品文档对照；不能据此推断闭源后端实现 |

API 证据：[ST](https://api.github.com/repos/SillyTavern/SillyTavern)、[Risu](https://api.github.com/repos/kwaroran/RisuAI)、[Cpp](https://api.github.com/repos/LostRuins/koboldcpp)、[Lite](https://api.github.com/repos/LostRuins/lite.koboldai.net)、[Agnai](https://api.github.com/repos/agnaistic/agnai)。最新 push 可能发生在非默认分支，不能直接视作默认分支 commit 日期。

固定提交：ST `06bde939fb1e9c4c8d8641d810f0a916b5bce127`（release）；Risu `cad8595aa39620df4246f56918f0962c2aa0263a`（main）；Lite `c8386449ab841facaed90b2efcaa74c58aca7b29`（main）；Agnai `fccee00f5f7628d150760c787c4be87e6b1a652c`（dev）。Cpp 的详细讨论依赖其官方 Wiki，内容可变，涉及数值或模型支持范围的旧段落不作为当前规格引用。

## 2. SillyTavern：最值得学习的是上下文工程可观察性

### 2.1 Prompt 是编译产物，而不是一根拼接字符串

**源码证实**：`prepareOpenAIMessages` 创建 `ChatCompletion`，用模型上下文减回复额度设置输入预算，然后编排 prompt；强制段超出预算时报告 `Mandatory prompts exceed the context size`。它先预留新聊天标识、群聊 nudge、续写 nudge 等必要开销，再装入历史。`ChatCompletion` 暴露预算预留、可负担检查、消息加入与预算释放操作。[构建入口](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L1564)、[预算公式](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L3982)、[历史前预留](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L892)。

**源码证实**：PromptManager 保存每块 token 数，总量超过输入预算的 80% 时检查历史 token 是否太少，分警告和危险阈值。可展开每条消息的 role/content/token。不是只显示一个“总字符数”。[模块计数](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/PromptManager.js#L1582)、[历史不足告警](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/PromptManager.js#L1673)。

官方 Prompt Manager 区分正常生成、续写、代写、swipe、重生成、后台 quiet 的触发类型；可以按块改变位置与消息角色。[官方说明](https://docs.sillytavern.app/usage/prompts/prompt-manager/)。

**适配推断**：剧本杀需要更严格版本的 ContextPlan：每块记录 `sourceIds / visibility / role / priority / tokenCost / inclusionReason`，关键规则、角色自身知识、当前任务是必要段；候选 RAG 和旧发言是可裁剪段。模型切换或 fallback 时重新按目标模型预算编译。角色私有 context inspector 应只给管理员/开发环境使用，普通玩家页面仅显示不泄密的统计。

### 2.2 世界书提供按需选择机制，不提供访问控制

**源码证实**：`world-info.js` 同时处理预算、关键词和递归激活、概率、inclusion groups、sticky/cooldown/delay；import 时这些字段从扩展信息映射回来。[世界书实现](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js)、[导入字段映射](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L5639)。

**官方证实**：条目的完整自包含内容才进入 prompt；激活关键词只是触发元数据。条目可按角色/persona/chat 指定；触发并不保证模型在输出中利用设定。[World Info 官方指南](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md)。

**适配推断**：为线索/地点/关系提供语义别名、阶段条件、合法可见座位、依赖条目与预算优先级。顺序必须是 `visibleTo + phase gate → 检索/触发 → 预算 → 注入`。如果先在全局秘密上计算 query、关键词或相似度，最后只过滤结果，仍可能泄露派生信息。递归条目不能绕过可见性。`disclosure: conditional` 应渲染真实 condition，并由引擎判定满足条件；“在 prompt 上写不要说”不构成安全边界。

### 2.3 摘要、向量记忆均考虑历史变动

**源码证实**：摘要存于消息 `extra.memory`，可从当前历史反向找最新摘要；chat change 刷新摘要。后台摘要完成前检查 group/chat/character 是否改变，改变就丢弃。订阅消息删除、更新、swipe 事件。[最新摘要与上下文检查](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/memory/index.js#L396)、[事件监听](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/memory/index.js#L1081)。这是“避免摘要写错聊天”的防护，**不是**对所有同 chat 历史修改建立完整 revision 校验。

**源码证实**：聊天向量以文本 hash 匹配当前历史；新增内容入索引、当前历史已不存在的 hash 被删除；摘要失败项可标记跳过而非阻塞整批。[向量同步](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions/vectors/index.js#L439)。

**源码证实**：后端索引路径按 `用户目录 / vectors / source / collectionId / model` 区分。模型切换不会直接复用原模型索引。[getModelScope/getIndex](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/vectors.js#L288)。source 和 model 隔离仍不等于所有 embedding 身份完整隔离：代码未在该路径包含 endpoint URL、模型实际版本、维度、分块策略；同名自建模型变更仍需要额外版本管理。

**适配推断**：本项目应记录 `embeddingProfileId / model / endpointIdentity / dimensions / normalization / chunkVersion`，余弦计算拒绝维度不等，模型变更使用新索引/明确重建；召回附带来源 seq 和原文 hash，失效记忆自动删除。RAG 返回不只是文本，而是证据对象，避免把角色曾经说的谎话升级为全局事实。

### 2.4 群聊与 prompt cache 存在取舍

**官方证实**：Swap 模式每次只放当前发言角色卡；Join 模式拼全部角色卡，有利于避免大块 context 改动，却可能合并人格。共享聊天历史是 ST 群聊的默认产品语义。[官方群聊指南](https://docs.sillytavern.app/usage/core-concepts/groupchats/)。

**源码证实**：一次群聊批次有 `group_generation_id = Date.now()`，多个角色依次 `await Generate`，每次开始前检查 `AbortSignal`，`finally` 恢复生成/UI 状态。[批次与串行生成](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/group-chats.js#L945)。

**适配推断**：公开世界与规则前缀稳定，角色自身私有前缀按 seat 独立，动态历史/RAG 放后面；缓存不能成为混合私密卡的理由。ST 的 batch id 是重生成批次标记，不应当宣称其具备房间事务或幂等保证。游戏流应加 `generationId + seat + turnEpoch + attempt`，迟到流须与当前 generation 对齐；取消应贯穿 provider、review、stream buffer 与提交阶段。

## 3. RisuAI：记忆来源与预算分配比“长记忆”名称更值得借鉴

### 3.1 HypaV3 记忆有来源集合，而非一个孤立 summary 字符串

**源码证实**：Summary 保存 `text` 与 `chatMemos: Set<string>`，序列化时变为数组。构建时通过最后一条摘要的最后来源 memo 找未摘要历史起点；`cleanOrphanedSummary` 只保留所有来源 memo 都还在当前聊天中的摘要。`preserveOrphanedMemory` 可以关闭自动清理。[主流程](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/memory/hypav3.ts#L183)、[清理逻辑](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/memory/hypav3.ts#L1646)。

**边界**：memo 身份集合证明的是“来源消息仍存在”；仅凭此代码不能保证原地修改同 memo 内容后摘要被重建，也不能保证身份无冲突。分支 UI 的 `branches.ts` 按内容的 32 位 hash 合并树，用来展示聊天分叉；不要将展示结构误作完整事件溯源数据库。[分支展示](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/gui/branches.ts)。

**适配推断**：用本项目已有 seq，但补 `branchId/stateRevision/sourceHashes`。摘要、建议回复、检索、审查都携带生成时的 revision；提交时不匹配则丢弃或重算。回滚必须撤销记忆、持有线索、投票和阶段等派生状态，不能只删除气泡。

### 3.2 记忆预算按重要/近期/相似等类型装箱

**源码证实**：HypaV3 用 `maxContextTokens * memoryTokensRatio` 预留记忆，验证 recent 与 similar 比例和不超过 1；重要记忆先占空间，再按预算选择近期/相似/其他摘要。超出空间时停选，并计入 XML 包装开销。[预算预留](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/memory/hypav3.ts#L233)、[重要记忆与后续选择](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/memory/hypav3.ts#L508)。

**适配推断**：剧本杀的“重要”应来自显式公共事实、本人已知线索、任务相关证据，而不是把所有对话总结都当同权重材料。随机回忆增加开放式 RP 丰富度，推理游戏中容易分散注意力，应先用任务相关性和必要性筛选。近期窗口用 token 预算而非固定中文字符数，检索应避开已完整保留的来源以防双计数。

### 3.3 cache 点与 embedding cache 身份均显式

**源码证实**：Prompt 模板支持 `cache` 块，按角色/depth 从已格式化 prompt 末尾标 `cachePoint`；automaticCachePoint 也会在最近 user 消息上做标记。[cache 标记](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/index.svelte.ts#L1413)。这是上游消息元数据机制，实际后端是否复用需看 provider 请求转换与返回 usage，不能据此量化节省比例。

**源码证实**：HypaProcessor 的浏览器 embedding cache key 是 `text | model`，custom 模型设置还加 model 名后缀。[cache key](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/memory/hypamemory.ts#L159)。同样未在此 key 中包含自建服务器 URL 或所有模型版本信息。

**适配推断**：本项目可以稳定 prefix + 模型能力 profile；通过 provider usage 记录 cached tokens 验证缓存是否生效。不要只按 API 是否“OpenAI 兼容”决定所有消息降成 user：role、system 支持、thinking、stop、schema 等均需要 provider 能力表。

### 3.4 流式取消与可靠性

**源码证实**：Risu 传递 `abortSignal` 到请求；stream reader 监听 abort，在循环检查取消，结束移除监听。记忆层有独立 summarization/embedding 请求速率和并发设置；不保证外部 provider 已停止计费。[流式 reader](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/index.svelte.ts#L1617)、[记忆任务限速器](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/memory/taskRateLimiter.ts)。

**适配推断**：主发言、后台摘要、embedding、建议回复分别设有限队列；主流程优先，辅助任务失败静默降级。已给玩家播出的内容无法通过落库时替换完全收回，涉及泄密审查必须在放出前完成；软质量修订可作为独立最终版事件，但要明确流式临时文本与最终文本的关系。

## 4. KoboldCpp + Lite：本地模型服务与应用编排要分清

官方 Wiki 明确 Cpp 是推理服务，Lite 是附带或独立前端。KV context shifting/fast forwarding 优化已处理 token 的复用，不能替代剧情摘要；动态世界书或前缀记忆变化会削弱复用。服务提供 token count、真实上下文查询、SSE、abort、性能统计接口，也有 model-specific Jinja/chat adapter。[官方 Wiki](https://github.com/LostRuins/koboldcpp/wiki)。

**源码证实**：Lite 允许角色卡以多种兼容来源导入，group participant 导入支持 Tavern/Risu 等格式；按后端构造 stop sequences，某些后端裁为前 4 个；有独立 `abort_generation`。[角色导入](https://github.com/LostRuins/lite.koboldai.net/blob/c8386449ab841facaed90b2efcaa74c58aca7b29/index.html#L11150)、[停止序列](https://github.com/LostRuins/lite.koboldai.net/blob/c8386449ab841facaed90b2efcaa74c58aca7b29/index.html#L21895)、[取消](https://github.com/LostRuins/lite.koboldai.net/blob/c8386449ab841facaed90b2efcaa74c58aca7b29/index.html#L19483)。

**适配推断**：为离线/隐私用户支持自建兼容服务，但是否可用取决于模型中文、推理、结构化输出与审查能力，必须使用固定剧本回归。后端 capabilities 记录 tokenizer/context/stop/schema/role/cache/abort；性能统计比较首句时间与整轮完成时间。继续文本截断不能保证有效 JSON 或游戏动作。Lite 的单文件交付降低部署成本，其大 HTML 文件不是当前 Next.js 工程需要复制的结构。

## 5. Agnai：多人、多 bot 与可测试的纯 prompt 构建

**官方证实**：Agnai 支持多用户、多 bot 群聊；数据库/Redis 可选，无 MongoDB 可用 guest 模式。与 ST 本地单用户使用面不同。[README](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/README.md)。

**源码证实**：`buildMemoryPrompt` 依次提取 enabled 条目、扫描近 depth 历史、按 priority/age 排序、按 token budget 筛选，再按 weight/age 排顺序。预算选择优先级和最终插入顺序分开，memoryContextLimit 默认回退 500，返回不多加换行以匹配计数。[memory 构建](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/common/memory.ts#L72)。

**源码证实**：prompt 逻辑位于 common 层，仓库有 prompt snapshot 与 system-prompt-extraction 测试。[构建](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/common/prompt.ts)、[测试](https://github.com/agnaistic/agnai/blob/fccee00f5f7628d150760c787c4be87e6b1a652c/tests/prompt.spec.ts)。

**适配推断**：将 context 规划和 provider 转换分开，纯函数可以测试“凶手/无辜/DM 同局分别得到什么”，而非只测试输出包含某个标题。不要照搬“浏览器里构建完整角色 prompt”：本项目多人公平性要求服务器不下发他人的秘密。多用户聊天功能不自动意味着 seat 信息隔离。

## 6. AI Dungeon 产品文档对照：留出可编辑区与检视入口

官方描述的 Memory System 结合摘要与 embedding 检索；每六个 action 产生记忆，最近六个 action 不受记忆影响，便于撤销/编辑。上下文管理页面提供组成与选择机制说明。[记忆系统](https://help.aidungeon.com/faq/the-memory-system)、[上下文管理](https://help.aidungeon.com/how-do-i-manage-context)。本轮不确认其闭源后端是否完全按文档执行，也不直接移植固定百分比。

**适配推断**：最近一段公开事件保持可撤销、未经不可逆压缩；为管理员提供“摘要来源/本轮命中证据/哪些材料因预算被舍弃”的调试面板。游戏仍以结构化事实和事件为权威，模型摘要只作上下文加速。

## 7. 角色卡与 few-shot：互操作格式不是剧本权限模型

[Character Card V2 官方规范](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)区分性格/场景/示例对话、system/post-history、creator metadata 和 bundled character book；未知 extensions 应保留。它**没有规定**剧本杀的公开/本人可见/条件披露权限层。本仓库旧报告所称“V2/V3 公开人设与秘密分层”不能当作卡片标准自带安全能力。

ST 用结构化 example dialogue 建立角色说话风格；示例是可独立控制保留/裁剪的上下文段。[示例对话源码入口](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/openai.js#L1101)。Risu 同样先解析 exampleMessage 并计入 token。[示例编排](https://github.com/kwaroran/Risuai/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/index.svelte.ts#L831)。

**适配推断**：本项目先完整利用已有 habits/taboos/relationships，再增加 2–3 组简短示例：“被质疑时”“该隐瞒时”“公开证据后”各一组。示例不能硬编码当前剧本真实凶手、未获线索或未来反转；它只训练口吻和应对策略。示例占独立有限预算，在必要证据之前被裁剪。是否改善风格应以同模型 A/B 评分验证。

## 8. 适配优先级与实验设计（建议，非已实施）

| 优先级 | 建议 | 为什么先做 | 可验收结果 |
| --- | --- | --- | --- |
| P0 | provider 能力/role 正确映射，保留 system；明确显式温度与绑定值优先级 | 目前若统一降成 user，再好的角色内容也失去指令层级 | Anthropic/OpenAI 兼容 mock 捕获真实 payload；绑定设置与实际请求一致 |
| P0 | conditional secret 条件完整渲染与引擎 gate，完善 persona 投影 | 现有信息能先被正确利用，比堆新特性更直接 | 同剧本各 seat prompt 无他人秘密；条件未满足不允许披露；人物口吻分化 |
| P0 | embedding 身份、维度与来源隔离 | 错空间相似度会无声提供错误记忆 | 不同 profile 不交叉命中；维度不同明确拒绝；重建可恢复 |
| P1 | ContextPlan + token budget + 裁剪 trace | 字符窗口不能保证不同 provider/fallback 的预算 | 输入+输出+安全余量不超窗；必要段不足有可诊断失败，不静默丢知识 |
| P1 | task-aware recall，先投影再 query，公共线索也可索引 | 泛最近四事件 query 与当前投票/搜证任务可能无关 | recall@k、证据覆盖、引用来源准确率提升；无不可见来源污染 |
| P1 | 所有异步生成携带 generation/revision，取消贯穿管线 | 流式、后台建议、摘要、回滚都可能产生迟到结果 | 取消/阶段切换/重试后旧 delta 与旧结果不会提交或替换新输出 |
| P2 | few-shot + 稳定 seat prefix + cache usage | 人格与性能改进可独立衡量 | 口吻差异评分、首句 P50/P95、缓存命中 token 占比；无秘密混卡 |
| P2 | 受控重说/分支回滚 | 很有产品价值，但会牵连游戏事实状态 | 单机练习/管理员先行；快照、事件、记忆、向量、建议一起换 branch |

建议固定 3 份不同复杂度剧本、2–3 类 provider/model，同输入 seed（支持时）与回合顺序，记录：他人秘密泄露率、本人 conditional 越权率、公开事实错误率、指凶准确率、重复率、persona 一致性、可见证据 recall@k、input/output/cached tokens、首句与整轮时延、辅助调用成本、取消后迟到提交数。推理正确性提升必须和秘密泄露分别报告，不能用“更会破案”掩盖看到不该看的信息。

## 9. 明确不建议直接照搬

- ST Join 全角色卡与群聊共享历史：对剧本杀的私密座位语义不适用。
- 世界书任意 prompt/脚本扩展：导入内容应是非可信数据，不能覆盖服务器规则或执行脚本；role 权限由应用决定。
- HypaV3 随机回忆、群聊随机 talkativeness：自由聊天可用，公平轮流推理流程先保持确定调度。
- 把 DRY/XTC/温度范围当通用人设药方：采样设置取决于具体模型/backend，不能从项目支持这些选项推出普遍最佳参数。
- 用 LLM 摘要建立全局权威真相：玩家可能撒谎，摘要须保留“某人声称”与来源，关键事实仍从引擎状态取得。
- 只复制客户端 AbortController：应用还要解决服务器迟到结果、重试幂等和状态提交，客户端取消并不保证 provider 停止生成。

源码许可证快照：ST/KoboldCpp/Lite/Agnai 仓库 API 标为 AGPL-3.0；Risu 为 GPL-3.0。本报告建议独立实现机制；如未来复制源码应单独核对许可证和目标交付形式，本轮没有复制应用代码。
