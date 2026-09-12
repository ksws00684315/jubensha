# 主流 AI 剧本/角色扮演玩法调研与本项目优化落地

> 调研日期:2026-09。目的:借鉴 SillyTavern(酒馆)、AI Dungeon、NovelAI、Character.AI、星野等主流 AI 角色扮演平台,以及开源 AI 剧本杀/狼人杀项目的成熟机制,优化本项目引擎。

## 一、调研结论:各平台的可移植机制

### 1. SillyTavern(酒馆)

把"角色扮演工程"拆成正交子系统,每个都值得对照:

| 机制 | 解决的问题 | 核心设计 |
| --- | --- | --- |
| World Info / 世界书 | 全量设定塞不进上下文 | 关键词(+副关键词,AND/NOT 逻辑)触发才注入;扫描最近 N 条消息;递归链式激活;token 预算(默认最大上下文 25%)超支按优先级丢弃;sticky/cooldown/delay 定时效果(秘密延迟解锁) |
| Character Card V2/V3 | 角色数据包跨平台分发 | 公开人设与秘密分层;`post_history_instructions`(钉在历史之后的最后叮嘱);meta 字段不进 prompt |
| Author's Note | 每轮都在、靠近生成点的指令 | 按深度插入聊天历史尾部,支持每 N 轮注入 |
| Prompt Manager | prompt 拼装顺序 | 固定槽位:系统提示→世界书→角色卡→示例对话→**聊天历史**→最后叮嘱;回复长度预留;超预算从最旧裁起、常驻优先 |
| 三层记忆 | 长对话失忆 | Summarize(滚动摘要,可回滚)+ 向量检索(400 字符分块、top3、最近 5 条不参与乱序)+ Data Bank(RAG);摘要/向量/关键词世界书各占预算、各走各的注入点 |
| Group Chat | 多角色发言调度 | natural order:最后一条消息的成员名整词匹配(mention)→ talkativeness 掷骰 → 兜底随机;禁止连说两次;历史共享、角色卡 swap |
| Regex 脚本 | 提示层与显示层分离 | "只改发往模型的 prompt"的不落盘改写;给 AI 看的与给玩家看的分离 |
| STscript `/createentry` | 记忆写入 | 聊天中把新事实实时写进世界书,后续按关键词触发 |

采样经验:温度 0.8-1.1 扮演更"像人";DRY/XTC 惩罚复读与口头禅。

### 2. AI Dungeon / NovelAI

- **AI Dungeon Memory System**:Required 区(指令/Plot Essentials/摘要/作者注)总量 ≤70% 上下文,超支按优先级**整段丢弃**;Dynamic 区 Story Cards 25% / 历史 50% / 记忆库 25%;Story Cards 按**触发词新近度+频率**排序;每 6 个行动产出一条 Memory,**最近 6 个行动永不摘要**(允许玩家反悔编辑)。
- **NovelAI Lorebook**:字符窗口(而非消息条数)更稳定;级联激活(条目内容互扫);Key-Relative Insertion(线索文本紧跟提及位置插入);类别级短语偏置。

### 3. Character.AI / 星野等中文产品

- **Character.AI 分层记忆**:Chat Memories(用户手填,受保护)+ auto-memories(自动捕捉,可压缩)+ **Facts 事实表**(自动抽取外貌/关系等事实,可编辑)+ Memory Usage 可视化。记忆对用户透明可编辑。
- **星野**:重说(备选回复)/回溯(剧情回滚)/评分反馈/推荐回复——**把纠偏权交给用户**是人设不崩的关键;few-shot 对话样例比长描述更能定人设。

### 4. 开源 AI 剧本杀 / 狼人杀

- **AI Alibis**(生成-审查-修订):每个角色分 `context`(愿意说的)/`secret`(隐藏)/`violation`(红线)字段;生成后**另一个 LLM 调用当审查者**,按显式原则列表机器可判地检查(哨兵串 `NONE!`),违规则最小改动重写。
- **AIwerewolf**:**信息隔离在引擎投影层做**(GameState → PlayerView 只读投影),agent 只提交结构化 Decision,不直接改状态;Persona/Role/Strategy 三层提示 + 策略检索。
- **ThinkThrice**(ACL 2024 剧本杀基准):评估三维——事实问答/推理问答/指凶准确率;结论:LLM 需要显式的信息跟踪与推理增强。

## 二、本项目落地(本次实现)

对照调研,按「性价比 × 不破坏现有架构」选出四项落地:

### 1. 滚动摘要分层记忆(`src/core/agents/memory.ts`)—— 对应 ST Summarize + AI Dungeon

- **问题**:原实现把全量事件流逐字塞进每次 LLM 调用,长局上下文线性膨胀(成本、质量双输)。
- **方案**:
  - 近期窗口(约 6000 字符)逐字保留;窗口之前的**公共**事件由 LLM 滚动压缩为一份事实条目式概要(≤500 字),锚定在 `GameEvent.seq`;
  - 记忆存于 `GameState.memory`(随快照持久化,重启不丢);新公共记录攒够约 2500 字符才触发一次后台摘要更新(互斥锁外调用,同 AI 投票决策模式);
  - 摘要只含公共事件(防火墙不变式):玩家私有的线索卡始终逐字出现在其上下文尾部【你持有的线索卡】,不会因摘要丢失;
  - 摘要锚点不可用/落后时自动退回全量日志,**正确性永远优先于成本**。
- **取舍**:摘要每次更新使前缀缓存失效一次(每小时级频率),换取长局上下文长度可控。

### 2. 真流式发言(`engine.ts` + `agents/index.ts`)—— 接通闲置的 `chatStream`

- **问题**:原实现 `generateText` 拿全文后用打字机模拟"流式",AI 开口前有最长 90s 的沉默。
- **方案**:
  - AI 玩家发言与 DM 旁白改走 `streamText`,token 到达即经 SSE 推送;
  - **句子级增量守卫**(`guard.ts` `createSpeechRedactor`):只有跨过句子边界、未命中泄露标记的句子才被放出——流式不再破坏"未守卫内容不到前端"的防火墙保证;
  - 流式失败逐级回退:部分输出直接采用 → 非流式(重试+fallback 链+全文守卫)→ 固定提示语;
  - 前端支持 DM 旁白流式(`delta.seat: "dm"`)。

### 3. 守卫覆盖"永不披露"的秘密(`guard.ts`)—— 对应 AI Alibis 的红线字段化

- **问题**:原守卫只防"他人未公开线索",不防 AI 念卡式说出自己的秘密(卡上写明 `disclosure: never`)。
- **方案**:把本角色 `disclosure: never` 的秘密标题(≥4 字)与内容片段加入守卫标记;`conditional` 秘密不拦(允许按条件披露的剧情);用自己的话部分承认不受影响(只匹配卡片原文)。
- 流式路径与非流式路径共用同一套标记(`playerGuardMarkers`/`dmGuardMarkers`),行为一致。

### 4. 讨论关键词触发线索提示(`memory.ts` `clueMentionHints`)—— 世界书思路适配

- **问题**:AI 玩家手里攥着关键线索,却不知道什么时候该打出,常见"全程藏牌到复盘"。
- **方案**:最近 12 条发言中**别人**提到"我持有的私藏线索"的名字时,上下文尾部注入【可打出的牌】提示,鼓励 AI 在合适时机用自己口吻亮牌(也可继续藏)。纯函数、零 LLM 成本,即酒馆"被提及才注入"的多人对局翻译。

## 三、第二批落地（对局互动五件套）

在首批四项之后，把此前"暂不落地"清单中产品价值最高的五项也做了实现：

### 5. mention 插话调度（`src/core/agents/mention.ts` + 引擎）—— 对应 ST 群聊 natural order

- **规则引擎只做激活**：真人发言点名了某位 AI 的角色名（`indexOf` 精确匹配、按文中出现顺序取第一人），该 AI 立即获得一次插话回应权；去掉了 ST 的 talkativeness 随机掷骰（轮流制对局里随机性是噪声）。
- 插话**不占任何人的正式发言回合、不改 turnSeat**，气泡带「插话」徽标；每轮讨论限 3 次（`MAX_INTERJECTIONS_PER_ROUND`），AI 之间不互相触发（防链式刷屏）。
- 插话内容走完整守卫 + 二次审查管线，流式在互斥锁外、补记事件时校验阶段未变。

### 6. AI 主动私聊（引擎 + `playerConsiderWhisper` + 前端回复框）

- AI 结束自己的讨论发言后，可审慎决定是否悄悄私信一位**真人**玩家（每 AI 每轮最多一次；决策 prompt 要求有明确动机：交换情报/试探/结盟/警告，无动机不发）。
- 私信事件 `visibility=seat:<收件人>`，发送方凭"自己发出的私聊对自己可见"规则（`visibleTo` 新增 fromSeat 分支）在自己的上下文里保留记忆；firewall 不变。
- 真人在私信气泡下可直接回复（`private_chat` 动作重新启用为**回复通道**，仅当对方窗口开着时可用）；AI 用 `privateReply` 以私聊口吻回一句。窗口计数 `state.privateChat`，回复即消费，AI 可再次开启。
- 私信内容同样过泄密守卫。

### 7. 推荐回复（`suggestReplies` + 状态 + 前端 chips）—— 对应星野"灵感/推荐回复"

- 轮到真人发言（自我介绍/圆桌）时，后台用**该座位自己的上下文与模型槽位**生成 3 条 ≤40 字、符合人设/秘密/目标的建议短句，存入 `state.suggestions`，概要 API 下发，前端一键填入输入框。
- 建议**逐条过泄密守卫**（凶手不会拿到暴露手法的建议）；发言/跳过/阶段切换即清除。
- 解决新手"不知道该说什么"的冷启动问题；LLM 调用失败时静默无建议，零打扰。

### 8. 二次审查（`src/core/agents/review.ts` + `refineSpeech`）—— 对应 AI Alibis critique→refine

- 守卫（guard.ts）管"泄露"硬红线；二次审查管两类软问题：**出戏**（台词里冒出 AI/助手/剧本杀机制等元话语）与**复读**（与该角色上一段发言开头雷同）。
- **启发式触发**：只有命中可疑标记才发起一次廉价审查调用（温度 0.1），判定 `ok:false` 时给出最小修改稿，修改稿再过一遍守卫后才采用；启发式未命中零成本。
- 挂在 `aiSpeak` 与插话路径的落库之前；流式已播出的原稿会被最终事件文本自然替换（前端气泡以正式 speech 事件为准）。

### 9. 向量检索记忆层（`embedTexts` + `EventVector` 表 + `recall.ts`）—— 对应 ST Chat Vectorization / AI Dungeon Memory Bank

- **写入侧**：公共发言/旁白/公开线索落库后异步向量化（1.5s 防抖批量），写入 `event_vectors` 表。
- **读取侧**：仅在滚动摘要已启用时（否则全量日志本就在上下文里，检索无意义），用最近几条发言作 query，余弦相似度 top3、阈值 0.3，把被摘要压缩掉的旧发言**原话**以【旧事重提】注回玩家/DM 上下文——摘要管"大意"，检索管"原话"，两层互补。
- **零配置降级**：设置页新增 `向量检索（记忆）` 槽位（OpenAI 兼容 `/embeddings`）；未绑定时 `embedTexts` 返回 null，整层静默关闭，不影响任何主流程。
- 检索候选按 `visibleTo` 过滤，防火墙不因向量层而破洞。

## 四、调研到但仍未做的方向

| 方向 | 来源 | 未做的理由 |
| --- | --- | --- |
| talkativeness 随机掷骰 / 多人队列连续发言 | ST 群聊 | 轮流制对局里随机发言权是噪声；mention 激活已覆盖最自然的插话场景 |
| 先摘要再向量化、向量结果乱序回注 | ST 实验特性 | 当前检索注入按时间正序、只取 top3，够用 |
| 重说(备选回复)/回溯/评分反馈 | 星野 | 需要产品级 UI（历史快照、分支管理），建议单独立项 |
| 剧本生成自动评审（无辜者 knowledge 不得点名真凶等） | docs/script-review-2026-09.md 的 S1-S7 | 属剧本质量管线，已有整改方案文档 |
| Memory Bank 容量淘汰/使用频率权重 | AI Dungeon | 当前每局事件量级小，等对局长度真成为瓶颈再做 |

## 四、来源

- SillyTavern 官方文档:World Info / Author's Note / Group Chats / Prompt Manager / Summarize / Chat Vectorization / Data Bank / Regex(https://docs.sillytavern.app)
- Character Card Spec V2/V3:https://github.com/malfoyslastname/character-card-spec-v2 、https://github.com/kwaroran/character-card-spec-v3
- AI Dungeon Help:The Memory System / What goes into the context / Plot Essentials(https://help.aidungeon.com)
- NovelAI Lorebook:https://docs.novelai.net/en/text/lorebook/
- Character.AI Blog:Smarter Memory / Chat Memories(https://blog.character.ai)
- 星野产品拆解:https://www.woshipm.com/evaluating/5946439.html
- AI Alibis:https://github.com/ironman5366/ai-murder-mystery-hackathon
- AIwerewolf:https://github.com/wxhfy/AIwerewolf
- ThinkThrice(ACL 2024):https://github.com/jackwu502/ThinkThrice 、https://arxiv.org/abs/2312.00746
