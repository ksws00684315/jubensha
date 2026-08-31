# 剧本输入标准 V2

V2 是面向剧本作者、AI 生成器和导入工具的语义数据标准。它解决的问题不是让作者控制页面样式，而是把“一个可渲染的信息单元”表达清楚，让页面能够用统一组件呈现。

机器可读约束见 [`schemas/script-input-v2.schema.json`](../schemas/script-input-v2.schema.json)，完整示例见 [`seeds/examples/script-v2.example.json`](../seeds/examples/script-v2.example.json)。权威实现位于 `src/core/script/v2/`。

## 1. 基本规则

- 根对象的 `version` 必须为 `2`。
- 所有集合对象使用稳定 `id`，格式为小写字母开头的小写字母、数字和下划线。
- 对象之间使用 ID 引用，不使用名称引用。名称可以修改，ID 不应随展示文案改变。
- 数组顺序有语义：角色、线索、个人时间线和真相时间线均按数组顺序展示；时间字段用于排序、筛选和对照。
- 文本叶只表达内容，不表达排版。文本中不要写 HTML、CSS 或 Markdown，也不要用换行模拟列表。
- 长文本拆成 `NarrativeBlock[]`：自然段使用 `paragraph`，条目使用 `list`，引用使用 `quote`。标题由领域对象的 `title` 或页面栏目提供。

## 2. 顶层结构

```text
ScriptDocV2
├── version
├── meta                    标题、人数、时长、难度、标签、简介
├── background[]            公开背景内容块
├── characters[]            公开资料 + 私人角色卡
├── locations[]             地点对象
├── clues[]                 线索对象
├── truth                   DM 真相、证据链、复盘
├── flow                    游戏流程参数
└── ending.outcomes[]       两种结局
```

`meta.intro` 是列表卡片使用的短简介，可以是一个字符串；“结构化”指拆分信息单元和关系，并不要求把每一个字包装成对象。

## 3. 内容与时间线

### NarrativeBlock

```json
{ "type": "paragraph", "text": "一个自然段" }
{ "type": "list", "style": "unordered", "items": ["事实一", "事实二"] }
{ "type": "quote", "text": "引文", "attribution": "来源" }
```

页面统一渲染这些类型；剧本输入不携带颜色、字号、边框、间距等视觉属性。

### TimelineEntry

```json
{
  "id": "event_1",
  "time": {
    "display": "21:15–21:25",
    "precision": "range",
    "start": { "dayOffset": 0, "time": "21:15" },
    "end": { "dayOffset": 0, "time": "21:25" }
  },
  "title": "值班室争吵",
  "content": [{ "type": "paragraph", "text": "事件经过。" }],
  "locationId": "office",
  "characterIds": ["suyu"],
  "clueIds": ["spare_key"]
}
```

`display` 是面向玩家的时间文字；`start`/`end` 用于排序和筛选，时间不确定时使用 `precision: "relative"`。数组顺序始终是最终展示顺序，不依赖前端从正文中猜测时间。

## 4. 角色卡

角色分为两个固定容器，避免公开资料与私密信息混在一起：

- `publicProfile`：公开身份、简介、公开关系。
- `privateCard`：背景、秘密、目标、个人时间线、额外情报、私人关系、人设和 `isCulprit`。

秘密是数组，每个秘密有 `disclosure: "never" | "conditional"`；目标是数组，每个目标有 `priority: "primary" | "secondary"`；情报使用 `source` 标明是亲眼所见、听闻、持有、推断或其他来源。这样页面可以分别显示卡片、标签、时间线和关系，而不必解析一段长文。

## 5. 地点、线索和真相

- `locations` 使用 `{ id, name, description[] }`，线索通过 `locationId` 关联。
- `clues.content` 使用内容块；`category` 用于统一图标和筛选；`policy` 保持现有的公开策略。
- `truth.method` 由摘要和有序步骤组成；每一步可关联线索。
- `truth.timeline` 使用时间线事件，并额外记录 `participantIds`。
- `truth.evidenceChain` 使用 `clueIds` 和推论组成证据链；不再用线索名称模糊匹配。
- `truth.redHerrings` 用对象记录误导线索及解释；无法可靠拆分的旧文本暂存到 `truth.supplemental[]`。
- `ending.outcomes` 必须同时包含 `culprit_caught` 和 `culprit_escaped` 两种结果。

## 6. 可见性边界

| 数据 | 普通玩家 | 对应页面 | 说明 |
|---|---|---|---|
| `meta`、`background`、`publicProfile`、地点 | 可见 | 剧本详情、对局读本 | 全局公开资料 |
| 当前玩家的 `privateCard` | 仅本人 / DM | 我的剧本 | 不得序列化到其他座位 |
| 线索正文 | 按 `policy` 和运行时状态 | 我的线索、DM 线索 | 发现前不可泄露 |
| `truth` | 仅 DM，复盘后按流程展示 | 真相、复盘 | 包含作案手法和证据链 |

可见性由应用的序列化层决定，不能由剧本作者通过新增 `visibility` 字段绕过。

## 7. V1 迁移

`migrateV1ToV2` 是保守、确定性的转换器：

- V1 长文本原样包装成内容块，不替原文补写事实。
- 时间线按明确的 `HH:mm` 标记拆分；无法识别的片段保留在补充内容，并输出警告。
- V1 地点生成稳定 ID，线索地点同步转换为 `locationId`。
- 已知情报转为 `knowledge[]`；单个秘密和目标分别转为一个数组项。
- 关键证据只有在能唯一匹配线索时才转成 `clueIds`，否则输出警告。
- 转换工具默认不覆盖目标文件；任何信息损失风险都必须以警告显式报告。

```bash
npm run script:validate -- seeds/examples/script-v2.example.json
npm run script:migrate -- seeds/generated/6p-zuihouyizhiwu.json
npm run script:migrate -- seeds/generated/6p-zuihouyizhiwu.json --out /tmp/zuihou-v2.json
npm run script:schema
```

## 8. 运行时接入状态

运行时、存储和页面都以 V2 为准。导入接口若收到 V1，会先转换成 V2 再入库；引擎、AI 和详情页直接消费 V2 字段。公开 API 只返回公开切片，私卡和 `truth` 仍按座位 / DM 鉴权返回。

新剧本应直接提交 V2。旧 JSON 可用 `npm run script:migrate` 转换，库内旧行可用 `npm run script:migrate-db -- --write` 回写。转换 warning 需要人工补齐动机、证据链和无法识别的时间信息。
