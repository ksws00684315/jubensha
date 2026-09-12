# 剧本全量审查 · 第二轮 + 开源剧本写法调研

> 日期:2026-09-11。范围:seeds/ 全部 33 本 V2 剧本(4 手写种子 + 29 AI 生成)。
> 前置:2026-09-01 第一轮审查(docs/script-review-2026-09.md, S1-S7)与整改(6cae11c)。
> 本文回答三个问题:①整改后剧本现状如何;②开源/行业的优秀剧本怎么写;③有哪些玩法当前引擎不支持,值得加。

---

## 一、审查结论:整改属实,但留下新伤 + 一批存量问题

校验器(`script:validate`)33/33 通过、0 error。第一轮 S1-S7 的修复经深度复核**基本属实且质量高于预期**:knowledge 已普遍"去名化"、结局全部差异化、motive/redHerrings 基本填齐、keyEvidenceIds 与证据链已对齐。但深度审查发现三类**整改遗留的新伤**和一批存量问题。

### P0(破坏推理闭环,应立即修)

1. **线索池超载 → 关键证据可能永不出现**(2 本)
   - 引擎事实:每轮每人随机 1 地点抽 1 张、线索不回池,全场发现数 = min(人数×轮数, 线索数)。
   - 云澜山庄 14 条线索 vs 5人×2轮=10 抽,**4 条必然永不出现**;毒源瓶/雪地脚印/保险柜举报信任何一条落选即断链。火锅局 9>8 同理。其余 31 本数学安全。
   - 修法:云澜砍到 ≤10 条或 flow.searchRounds 改 3;火锅局砍 1 条。
2. **truth.timeline 被机械切分**(全库 33 本,19 本未按时间排序)
   - 长复盘文本按句硬切,产生残条(极夜/深夜食堂的内容仅"）。";决胜局秒数被切进正文;海沟 supplemental 仅剩"216 日"),redHerring 文案截断(南洋"顾曼的公积金挪款与")。
   - 修法:脚本清理 + 按 start 重排;必要时用 LLM 重新合并断句。
3. **凶手卡自相矛盾**(海沟七号):温书 secret("16:20-16:35 从风道夹层进出")与 backstory/truth("16:05 就完事、16:15 延迟触发,窗口是干扰项")直接冲突——AI 演凶会行为分裂。极夜特快宁霜 timeline 是"时间待整理"占位,主要证人不可用。

### P1(明显伤体验)

4. **"半点名"残留 9 本**:名字级点名只剩 1 条(王府年宴萧令仪 k2 直接写"古延年"),但"去名留唯一指代"的实质锁凶仍有存量,最重:决胜局两条"**是他的**"(帐号/灰连帽衫)、雪乡夜话"那丫头"、午夜电台"走廊只进出过一次"(导播唯一化)、云澜"她+出诊包"。AI 拿到这类条目必然下一轮就抛出,第 1 轮讨论直接进终局——比真人局更致命。
5. **keyEvidenceIds/evidenceChain 偏瘦**:科场疑云/上元灯影/书院惊雷 key=1、chain=1(第一轮 S5 的原始案例未修净);守陵 4/8、贺卡 4/9 覆盖率低;决胜局两条 chain 引用同一组 clue。
6. **motive 约 25 本是粘贴的凶手 backstory 首句**,保留第二人称"你叫XXX"——复盘展示穿帮;部分本装的根本不是动机(极夜装了"门虚掩手抖")。
7. **"实质点名"类 knowledge 条目的修复**应写成生成器的硬规则(见第三节规范 R3)。

### P2(锦上添花)

8. **结构化字段大面积烂尾**:clue.category 99% 为 other;redHerrings.clueIds 100% 为空(红鲱鱼只活在复盘文本里);disclosure=conditional 全库零使用;每人恰好 1 个秘密(设计意图 1-2 个);locations.description 32/33 为空(仅天池雪会填了且质量好)。
9. 个别悬空线索:祠堂的蛇消失无交代、深夜食堂"一掌缝钻人"物理矛盾、雁归楼柴房咳嗽无着落。

### 每本评分(摘要)

| 分档 | 剧本 |
| --- | --- |
| 8-8.5 可直接开 | 深夜食堂、南洋船票、王府年宴、海沟七号 |
| 7-7.5 小修 | 极夜特快、决胜局、祠堂夜祭、雁归楼、天池雪会、红眼航班、茶马古道 |
| 6-6.5 中修 | 云澜山庄、雪乡夜话、守陵疑云、落槌之前、雾锁戏班、旧影楼、修复室、编辑部、漕运、彩排、假面温泉、荒漠营地、尾舱来客、厨王、最后一支舞 |
| ≤5.5 需返工 | 午夜电台 5.5、火锅局 5、第七封贺卡 5、科场疑云 5、上元灯影 4.5 |

(逐本一句话评语见审查代理原始报告要点:上元/科场/贺卡共性 = 推理链覆盖 3-4/8-9 + key/chain=1;午夜电台 = 导播唯一化变相点名;火锅局 = keyEvidence 恰在必丢池内。)

---

## 二、开源与行业剧本是怎么写的(可借鉴经验)

### 行业规范(中国剧本杀)

- **三件套**:角色剧本 + 线索卡 + **组织者手册**(流程时间轴/线索解析/真相复盘/**扶车指南**)。
- **分幕是主流交付形态**:每幕"读本(解锁新内容)→搜证→讨论"交替,信息按"嫌疑→时间线→手法→动机"分层释放,**没有哪一幕一次给完**——我们当前单次 READING 全量发卡是最大节奏差距。
- **信息三档**:必说/可隐瞒/可撒谎(好人可隐瞒不可说谎,凶手可说谎)——我们的 disclosure 只有 never|conditional,缺 must_share 档。
- **线索金字塔**:核心:辅助:干扰 ≈ 2:5:3;行业硬规则**单条线索不锁凶**(人证+物证交叉),排除法不能单独使用;发放计划(每幕发几张、哪些角色禁搜哪些线索)写死在剧本里;"不能搜自己的房间"。
- **DM 手册三大核心**:流程控制、真相复盘、扶车指南(卡关应急提示)。
- 每个角色都是主角、"必说信息"标注在流程里;线索公开规则三档(全公开/限藏 N 张/不限)。

### 开源项目(具体可抄的字段设计)

| 项目 | 值得抄的点 |
| --- | --- |
| [ai-jubensha-fusion](https://github.com/w93139/ai-jubensha-fusion) | 与我们场景最接近。`PackagePhase` 链表=多幕;`release{phase + required_public_evidence_ids}`=**带前置条件的阶段性自动公开**;disclosure 含 MUST_SHARE;knowledge 区分 FACT/CLAIM/INFERENCE(防 AI 把谣言当事实);行动点预算 `InvestigationMechanics`;`FinaleRules`(多选项问题+事实组评分结局);`retelling` 转述权限;`SpeechMemoryTrigger`(听到关键词触发回忆插话) |
| [whodunit-voice](https://github.com/williamjxj/whodunit-voice) | 角色卡 `alibi`(不在场证明独立字段)、`revealRules`(何时可吐秘密)、`tells`(说谎小动作)、线索 `keywords[]`(说出关键词才解锁)、`CASE-PIPELINE-SPEC.md` 的"生成→校验→AI 试玩冒烟"流水线 |
| [ai-murder-mystery](https://github.com/ScottishFold007/ai-murder-mystery) | `violation` 字段:每角色一条"AI 绝不可踩的红线"显式清单 |
| [jubensha-ai](https://github.com/JianWang97/jubensha-ai) | 证据 `importance` 分层、地点 `searchable_items[]` + `is_crime_scene` |
| [the-one-truth](https://github.com/windstick/the-one-truth) | 附 2 个真实中文封闭本全文,可当"兼容真实剧本格式"的语料 |
| [mystery-o-matic](https://github.com/mystery-o-matic/mystery-o-matic.github.io) | 用逻辑求解器生成并**机器验证唯一解**——我们的 evidenceChain 可作为生成后的唯一解校验输入 |
| Freeform Games / Hunt A Killer / SHCD | freeform 流派(道具/金钱/能力卡)、"证据即文档、分集释放"、SHCD 的"地点=可查询 lead 表"空间机制 |

---

## 三、玩法优化项(当前引擎不支持的机制,按 价值×难度 排序)

### P0:高价值、低难度(动 Schema + 生成器为主,引擎小改)

| # | 机制 | 行业依据 | 改法要点 |
| --- | --- | --- | --- |
| 1 | **多幕读本(acts)** | 商业主流交付形态;信息分层释放 | `flow.acts[]` + `privateCard.stages[](actId, appendKnowledge 等)`;引擎在每轮 SEARCH 前插 READ_ACT(现有 [SEARCH→DISCUSSION]×N 循环已就位,小改) |
| 2 | **必说信息(must_share)** | "必说/可隐瞒/可撒谎"第一档 | `secrets/knowledge/objectives[].disclosure` 枚举扩为 `must_share\|may_share\|never`(conditional 并入 may_share+condition);agent 层按幕/轮强制带出——防 AI 局信息不流动的最便宜手段 |
| 3 | **线索发放计划+阶段性自动公开(release)** | "每幕发几张、二轮给深层线索"写死在剧本里 | `clues[].release {round?, afterCluePublicIds?}`;引擎按 release 过滤替代纯随机;顺带修掉 P0 线索池超载 |
| 4 | **搜证权限(禁搜)** | "不能搜自己的房间/某线索某角色搜不到" | `clues[].forbiddenCharacterIds/onlyForCharacterIds`;`locations[].ownerCharacterId`(默认本人禁搜) |
| 5 | **DM 手册数据化(hostGuide)** | 行业 DM 手册三核心 | `hostGuide {perPhase[dmNotes], stallBreakers[{condition, hint}]}`;卡关时 AI 角色主动抛线索——已有真人 DM 页可直接消费 |
| 6 | **锁凶校验规则(validator)** | 单线索不锁凶、排除法不单独用 | `validate.ts` 加规则:每条 evidenceChain `clueIds.length ≥ 2` 且物证+证词混合;核心证据分散 ≥2 地点;线索数 ≤ 人数×轮数(直接拦住云澜类超载) |

### P1:高价值、中难度

| # | 机制 | 说明 | 改法要点 |
| --- | --- | --- | --- |
| 7 | **多选项投票/结构化结局** | 现在结局天花板是二元(culprit_caught/escaped);阵营本/情感本/还原本都需要条件组合结局 | 抄 fusion `FinaleRules`:`ending.questions[] {prompt, options}` + 结局绑定 `supportAtoms {factGroups, minimumFacts}`;`voteMode: culprit\|choice\|hybrid` |
| 8 | **阵营/多胜利条件(最小变体:凶手+帮凶)** | 帮凶=拿到凶手关键线索并隐瞒;行业惯例入门形态 | `truth.culprits[]/accompliceIds[]`;先只支持"凶手+帮凶"再扩展 |
| 9 | **技能卡/行动点** | 机制本大机制;给真人"点验 AI"的工具(强制 AI 出示某知识),弥补真人质询弱势 | `flow.actionPointsPerRound` + `characters[].skills[] {cost, effect: verify\|frame\|trade, once}` |
| 10 | **线索交易/转卡** | 私聊的核心动机;keep_private 卡可转手 | 事件总线加 `CLUE_TRANSFER`;state 记持有权;通道已有,只差消息类型 |

### P2:有价值、高难度(后置)

空间移动/相遇机制(SHCD lead 表)、道具与金钱、死亡退场+鬼魂、搜身/强制验看(可并入技能卡 effect 先落地)、时间回溯(复盘已覆盖核心爽点)。

### 角色卡"低成本高回报"字段(从开源直接抄进 v2/v3 Schema)

- `alibi`(不在场证明独立字段,审讯对线刚需)
- `violation`(该角色的 AI 红线清单,接进 guard/refine 管线)
- `tells`(说谎小动作,凶手 AI 演技抓手)
- `knowledge[].kind: FACT|CLAIM|INFERENCE`(防 AI 把听来的谣言当亲见事实——对防火墙发言质量直接有效)

---

## 四、建议的执行顺序

1. **数据修复批(脚本可自动化)**:truth.timeline 清理重排(33 本)、motive 重写为第三人称(25 本,LLM 批处理)、王府年宴点名条修净、海沟温书矛盾统一、极夜宁霜时间线补全、云澜/火锅局线索池超载。
2. **半点名修复批(LLM 批处理)**:9 本"实质点名"knowledge 再糊化(参考守陵/茶马的修复标准)。
3. **结构化补全批**:keyEvidence/chain 对齐(3 本最弱)、category、redHerrings.clueIds、locations.description、disclosure=conditional 启用、第二秘密。
4. **Schema v2.x 增量**:P0 的 6 项(acts/must_share/release/禁搜/hostGuide/validator 新规则)+ 角色卡四字段(alibi/violation/tells/kind)。
5. **引擎玩法批**:P1 的结构化结局与技能卡按需求排期。

## 五、执行记录(2026-09-12 本轮落地)

### 已完成

- **项①数据修复批**:
  - truth.timeline/角色时间线:21 条机械切分残条合并、34 条时间线按 start 重排(33 本全量);
  - motive 重写为第三人称客观动机 20 本(极夜/雁归楼/雪乡/红眼/荒漠/天池/深夜食堂/旧影楼/决胜局/书院/午夜电台/修复室/漕运/祠堂/落槌/上元/雾锁/南洋/王府/云澜),云澜 motive 由空补齐;
  - 王府年宴萧令仪 k2"古延年"点名条修净;海沟温书 secret 与真相统一(15:50-16:05 操作、16:15 延迟触发、维护窗口留作干扰项),supplemental 截断补全;极夜宁霜时间线由"时间待整理"占位补为三条完整条目;
  - 线索池超载:云澜 14→10(裁遗嘱草稿/雪茄烟头/录音笔/收购意向书)、火锅局 9→8(裁手包里的火柴盒),搜证轮数不变,smoke 测试兼容。
- **项②半点名修复批**:15 条"实质点名"knowledge 糊化(决胜局×2、雪乡×2、午夜电台×2、云澜×2、落槌×2、天池、编辑部、厨王、守陵、王府),糊化标准:去唯一指代、保留信息价值、降为"线索需交叉验证"。
- **项③结构化补全批**:302 条线索 category 自动分类(medical/digital/document/trace);103 条红鲱鱼 clueIds 挂接;科场/上元/书院三本 keyEvidenceIds+evidenceChain 重写(单线索链→双链交叉,5/4/5 条关键证据);4 本手写种子 locations.description 全量撰写。
- **项④Schema v2.x 增量**(schema.ts/validate.ts/engine/context):
  - 新字段:`secrets.disclosure` 增 must_share 档;`knowledge.kind`(fact/claim/inference);角色卡 `alibi`/`violation`/`tells`/`stages`(分幕增量);`clues.forbiddenCharacterIds`/`release{round,afterCluePublicIds}`;`locations.ownerCharacterId`;`flow.acts[]`(分幕读本);剧本根 `hostGuide{perPhase,stallBreakers}`。全部带默认值,33 本旧数据零改动兼容。
  - 引擎消费:搜证按 release/禁搜/主人房过滤(`clueReachable`/`availableLocations(seat)`/`cluesAt(loc,seat)`,"不能搜自己的房间"硬规则);transitionSearch 宣幕;上下文注入【本幕新知】【亲见/传闻/推断】前缀、alibi/violation/tells、must_share 提示;DM 上下文注入主持人手册+扶车指南。
  - 校验器新规:R1 线索数 > 人数×轮数 → **error**;R2 证据链单线索 → warning;S1 残留真凶姓名检测 → warning;acts/stages/owner/release 引用校验。JSON Schema(`schemas/script-input-v2.schema.json`)已再生成同步。
  - 测试:v2x.test.ts 10 项(向后兼容/新字段/校验新规/unlockedActs/clueReachable/上下文消费/公开切片不泄漏)。全套 112 tests 全绿。
- **全量验证**:33 本 0 error(存量 R2 单线索链 warning 留作债务标记);剧本已同步数据库(sync-seed-scripts --write,更新 33);npm build + pm2 restart 完成,:3000 已运行新代码。

### 项⑤决策:结构化结局/技能卡/线索交易——按报告原建议"按需求排期",本轮不做

理由:三者均需产品级 UI 与状态机扩展(投票题型组件、行动点预算、转移所有权),且当前 33 本没有一本用到这些机制;先把数据层和 P0 Schema 修到位,等有第一批机制本/阵营本需求时按 fusion FinaleRules 参照实现。这是执行顺序表里的原定结论,非遗漏。

### 遗留(下轮候选)

- 29 本生成书的 locations.description、第二秘密、disclosure=conditional 启用:属内容创作型 P2,应进**生成器规范**让新书自带,而不是回头人肉补 33 本(报告第三节生成器三规则已含 R1-R3)。
- 29 本中 8 本的 R2 单线索证据链 warning:同样建议随生成器管线重写,人工逐本修补性价比低。

> **生成器三条硬规则**(防止新剧本再犯,已部分实现于 validate.ts):
> R1 线索数 ≤ 人数×轮数(已实现,error 级);R2 每条锁凶链 ≥2 条线索且人证物证交叉(已实现,warning 级);R3 无辜者 knowledge 不得含真凶姓名与"唯一指代+排他描述"(真凶姓名检测已实现 warning 级;唯一指代检测依赖语义,进生成管线)。

---

## 六、审查与优化轮(2026-09-12)

五项执行完毕后,由独立评审代理对本轮工作做了全量质检(机械扫描 33 本 + 6 本精读 + git diff 逐字段复核 + 代码走读 + 测试/校验/防火墙回归),结论"有条件通过",并给出 S1/S2 两个严重项与 M1-M7 中等项。优化轮已全部处置:

**已修复(严重)**
- S1 校验盲区:S1 规则扫描面从 knowledge 扩大到无辜者全卡通道(secrets/backstory/objectives/timeline/knowledge 标题+正文/alibi);王府年宴萧令仪的四通道"古延年"残留(秘密/背景/目标/知识)全部去名化为"经手签押之人"。复检:33 本 S1 警告 0 条。
- S2 owner 防御纵深:`dispatchClues` 补 owner 兜底(选中自己房间→"本轮搜证落空"且不发线索);超时/AI 兜底选点改用 `fallbackLocations`(排除本人房间,发放计划/禁搜放宽但 owner 不可绕),最坏情况仍有 location 兜底且流程不卡死。

**已修复(中等)**
- M2 motive 第二人称残留 7 本(海沟/尾舱/火锅/贺卡/报馆/编辑部/厨王)全部重写为第三人称。复检:0 残留。
- M3 VOTE 阶段幕回退:`unlockedActs` 对 VOTE 视为全部解锁(投票必在搜证之后),补测试。
- M4 雪乡郭翠 backstory/objective 的"那丫头/白桦"残留糊化。
- M5 云澜连带不一致:时间线与白慕森 knowledge 对已裁线索(录音笔/收购意向书)的引用改写;云澜/书院各补 2-3 条结构化红鲱鱼(此前 0 条)。
- M6 category 错标 5 条修正(邮件草稿→digital、报纸包→object、弹壳→trace、巡查日志→document、急救记录→medical)。
- M7 测试补洞:v2x 测试 10→15 项(新增 S1 多通道、VOTE 幕、hostGuide 防火墙断言)。
- B1 R1 口径改用实际角色数;B2 概要 API availableLocations 改为座位视角(与引擎同口径);B3 myCardV2 的 stages 按解锁裁剪(封自我剧透);B4 hostGuide 强转清理+must_share 标题语义;B6 同轮多幕逐一宣读。

**登记为债务(与生成器规范合并处理)**
- M1 逐字断句合并:机械清理(纯标点残条/乱序)已 0,但约 118 条"句中断开"条目仍在——本轮已手工合并最重灾区(云澜/海沟/极夜/荒漠的破案链截断与凶手卡断条),其余随生成器管线重写。
- 25 本 R2 单线索证据链 warning、29 本生成书地点描述/第二秘密/conditional:随生成器规范批量清偿。
