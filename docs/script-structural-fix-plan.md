# 剧本结构性数据整改方案

**日期**: 2026-09-01
**范围**: 全部 32 个 V2 种子文件
**目标**: 填充空字段、修复模板化内容、对齐证据链

---

## 一、问题清单与数据源

| # | 问题 | 影响范围 | 数据源 | 可自动化 |
|---|------|---------|--------|---------|
| 1 | `truth.motive` 全部为空 `[]` | 32/32 | 真凶 backstory + secrets | 部分可 |
| 2 | `truth.redHerrings` 全部为空 `[]` | 32/32 | 最后一条 truth.timeline 事件文本中的"红鲱鱼："段落 | ✅ 可 |
| 3 | `ending.outcomes` 两个结局文案完全相同 | 32/32 | 真凶 ID + 角色名 | ✅ 可 |
| 4 | `evidenceChain[*].conclusion` 只有线索名，不是推理结论 | 32/32 | 需要基于线索内容和链上下文重写 | ❌ 需 LLM |
| 5 | `method.steps[*].clueIds` 全部为空 `[]` | 32/32 | method.summary 文本中提到的线索 | 部分可 |
| 6 | `method.steps[0]` 与 `method.summary` 完全重复 | 32/32 | 需要拆分为独立步骤 | ❌ 需 LLM |

---

## 二、可自动化的修复（写脚本批量处理）

### Fix 1: 填充 `truth.redHerrings`

**数据源**: 每本剧本的最后一条 `truth.timeline` 事件文本末尾都有一段 `红鲱鱼：XXX、YYY、ZZZ` 的格式化文本。

**提取逻辑**:
```
1. 找到 truth.timeline 最后一个事件
2. 用正则 /红鲱鱼[：:](.+?)(?:——|$)/ 提取红鲱鱼文本
3. 按"、"分割为条目
4. 为每个条目生成 redHerring 对象：
   {
     "id": "red_herring_N",
     "clueIds": [],  // 后续手动补充
     "explanation": [{"type": "paragraph", "text": "条目文本"}]
   }
5. 写入 truth.redHerrings
```

**预期产出**: 每本剧本 3-5 个红鲱鱼条目。

**示例** (火锅局):
- 输入: `红鲱鱼：曹姐的离婚协议与偏心锅底、雷婷的隐匿证据与婆家关系、酸梅汤的无毒化验`
- 输出:
  ```json
  "redHerrings": [
    {"id": "red_herring_1", "clueIds": [], "explanation": [{"type": "paragraph", "text": "曹姐的离婚协议与偏心锅底"}]},
    {"id": "red_herring_2", "clueIds": [], "explanation": [{"type": "paragraph", "text": "雷婷的隐匿证据与婆家关系"}]},
    {"id": "red_herring_3", "clueIds": [], "explanation": [{"type": "paragraph", "text": "酸梅汤的无毒化验"}]}
  ]
  ```

**后续手动工作**: 为每个红鲱鱼补充 `clueIds`（关联到具体线索）。

### Fix 2: 生成差异化 `ending.outcomes`

**数据源**: `truth.culpritId` → 角色名

**逻辑**:
```
1. 从 truth.culpritId 找到对应角色的 name
2. culprit_caught 内容改为:
   "经过激烈的讨论与搜证，众人终于揭开了{name}的伪装。真相大白，正义没有缺席。"
3. culprit_escaped 内容改为:
   "尽管疑点重重，{name}成功混淆了众人的视线。真相被埋入雪夜，正义未能降临。"
```

**示例** (云澜山庄, 真凶=苏婉):
- caught: "经过激烈的讨论与搜证，众人终于揭开了苏婉的伪装。真相大白，正义没有缺席。"
- escaped: "尽管疑点重重，苏婉成功混淆了众人的视线。真相被埋入雪夜，正义未能降临。"

**注意**: 这是模板化方案。每本剧本的 ending 应该有基于剧情的差异化叙事，但批量处理先用模板，后续逐本优化。

### Fix 3: 填充 `truth.motive`（半自动）

**数据源**: 真凶的 `privateCard.backstory` 和 `privateCard.secrets`

**逻辑**:
```
1. 从 truth.culpritId 找到 isCulprit=true 的角色
2. 提取该角色 backstory 的叙事文本
3. 提取该角色 secrets 中 disclosure="never" 的秘密文本
4. 合并为 truth.motive:
   [{"type": "paragraph", "text": "backstory 关键段落"}]
```

**问题**: backstory 通常很长（包含大量背景信息），不能直接整段搬入 motive。需要提取"为什么杀人"的核心动机段落。

**建议方案**:
- **方案 A**: 用 LLM 从 backstory 中提取 1-2 句动机摘要
- **方案 B**: 手动为每本剧本写 1 段动机（32 本 × 2 分钟 ≈ 1 小时）
- **方案 C**: 从 `truth.reveal` 文本中提取动机相关句子（reveal 通常已包含动机概述）

**推荐方案 C**: reveal 文本中的动机描述通常是最精炼的。可以用正则提取 reveal 中"动机"相关的句子。

### Fix 4: 为 `method.steps[*].clueIds` 填充关联线索

**数据源**: `method.steps[*].content` 和 `method.steps[*].title` 中提到的线索名称

**逻辑**:
```
1. 遍历 method.steps
2. 对每个 step，用其 title/content 中的关键词匹配 clues[*].name
3. 将匹配到的 clue id 填入 step.clueIds
```

**问题**: 线索名称在 step 文本中的表述可能不完全一致。需要模糊匹配。

**建议**: 先用精确匹配，再用包含匹配。对于无法自动匹配的，标记为待手动补充。

---

## 三、需要 LLM 或手动处理的修复

### Fix 5: 重写 `evidenceChain[*].conclusion`

**当前状态**: conclusion 只有线索名（如"低钠盐"、"烟锅"、"弹壳"），不是推理结论。

**期望状态**: 每个 conclusion 应该是一句推理结论（如"死者并非自然死亡"、"凶手同时具备进入条件和明确动机"）。

**处理方式**: 需要基于线索内容和链上下文，为每个 evidenceChain 条目写一句逻辑结论。这是最耗时的工作。

**建议**:
- **批量处理**: 用 LLM 读取每个 evidenceChain 的 clueIds 对应的线索内容，生成结论
- **人工审核**: LLM 生成的结论需要人工审核准确性

### Fix 6: 拆分 `method.steps[0]`

**当前状态**: method.steps 只有 1 个步骤，且内容与 method.summary 完全重复，clueIds 为空。

**期望状态**: method.steps 应该包含多个离散步骤，每个步骤关联到具体线索。

**处理方式**: 需要基于 method.summary 的文本，拆分为 2-4 个步骤，并为每个步骤关联线索。

**建议**: 这需要对每本剧本的作案手法有深入理解，建议手动处理或用 LLM 辅助。

---

## 四、执行计划

### Phase 1: 自动化修复（写脚本，预计 30 分钟）

| 修复项 | 输入 | 输出 | 脚本逻辑 |
|--------|------|------|---------|
| redHerrings | truth.timeline 末尾"红鲱鱼："文本 | truth.redHerrings 数组 | 正则提取 + 分割 |
| ending.outcomes | truth.culpritId + 角色名 | 差异化结局文案 | 模板替换 |
| method.steps.clueIds | step 文本 + clue names | 关联线索 ID | 模糊匹配 |

### Phase 2: 半自动修复（脚本 + 人工审核，预计 2 小时）

| 修复项 | 处理方式 | 人工工作量 |
|--------|---------|-----------|
| truth.motive | 从 reveal 文本提取动机句 | 每本审核 1 分钟 |
| evidenceChain.conclusion | LLM 生成 + 人工审核 | 每本审核 2 分钟 |
| method.steps 拆分 | LLM 生成 + 人工审核 | 每本审核 2 分钟 |

### Phase 3: 逐本优化（可选，后续迭代）

| 修复项 | 工作量 | 说明 |
|--------|--------|------|
| ending 文案剧情化 | 每本 5 分钟 | 基于剧情写差异化叙事 |
| redHerrings clueIds 补充 | 每本 2 分钟 | 关联到具体线索 |
| method.steps 精细化 | 每本 3 分钟 | 拆分更细致的步骤 |

---

## 五、脚本实现方案

### 脚本 1: `fix-redherrings.mjs`

```javascript
// 读取所有种子文件
// 对每个文件:
//   1. 找到最后一条 truth.timeline 事件
//   2. 正则提取 "红鲱鱼[：:](.+?)(?:——|。|$)"
//   3. 按"、"分割
//   4. 生成 redHerring 对象数组
//   5. 写入 truth.redHerrings
//   6. 保存文件
```

### 脚本 2: `fix-endings.mjs`

```javascript
// 读取所有种子文件
// 对每个文件:
//   1. 从 truth.culpritId 找到角色名
//   2. 生成差异化结局文案
//   3. 写入 ending.outcomes
//   4. 保存文件
```

### 脚本 3: `fix-motive.mjs`

```javascript
// 读取所有种子文件
// 对每个文件:
//   1. 找到 isCulprit=true 的角色
//   2. 提取 backstory 中的动机段落（取前 2-3 句）
//   3. 写入 truth.motive
//   4. 保存文件
```

### 脚本 4: `fix-method-clueids.mjs`

```javascript
// 读取所有种子文件
// 对每个文件:
//   1. 遍历 method.steps
//   2. 用 step.title 匹配 clues[*].name
//   3. 填充 step.clueIds
//   4. 保存文件
```

---

## 六、验证清单

修复完成后，对每个脚本验证：

- [ ] `truth.motive` 非空（至少 1 个 narrative block）
- [ ] `truth.redHerrings` 非空（至少 1 个条目）
- [ ] `ending.outcomes[0].content` ≠ `ending.outcomes[1].content`
- [ ] `evidenceChain[*].conclusion` 不是纯线索名（至少 5 个字）
- [ ] `method.steps[*].clueIds` 至少有 1 个非空
- [ ] 所有引用的 clueId 在 clues 数组中存在
- [ ] JSON 语法正确
- [ ] V2 schema 校验通过（0 error）
