/** 剧本生成（stage=2）的 JSON 结构提示词。从 API 路由收纳到 core/script，与 schema/validate 同处一地维护。 */
export const SCHEMA_HINT = `输出必须是一个 JSON 对象，version 固定为 2，结构如下（字段名固定）：
{
  "version": 2,
  "meta": { "title": "剧名", "minPlayers": 人数, "maxPlayers": 人数, "durationMin": 分钟数, "difficulty": "新手|进阶|硬核", "tags": ["标签"], "intro": "一句话简介" },
  "background": [{"type":"paragraph|list|quote", "text":"..."}],
  "characters": [{ "id":"小写拼音id", "name":"姓名", "publicProfile":{"identity":"公开身份", "bio":[内容块], "relationships":[{"characterId":"id","label":"关系"}]}, "privateCard":{"backstory":[内容块], "secrets":[{"id":"id","title":"秘密标题","content":[内容块],"disclosure":"never|conditional|must_share","condition":"条件"}], "objectives":[{"id":"id","title":"目标标题","content":[内容块],"priority":"primary|secondary"}], "timeline":[时间事件], "knowledge":[{"id":"id","title":"情报标题","content":[内容块],"kind":"fact|claim|inference","source":"witnessed|heard|possessed|inferred|other","relatedCharacterIds":[],"relatedClueIds":[]}], "relationships":[], "persona":{"traits":[],"speechStyle":"说话风格","habits":[],"taboos":[]}, "isCulprit":true/false, "alibi":[内容块], "violation":["无论怎么被逼问都绝不能说破的事"], "tells":["说谎时的小动作"], "stages":[{"actId":"幕id","knowledge":[同 knowledge],"objectives":[同 objectives]}], "skills":[{"id":"id","name":"技能名","description":"效果","cost":1,"phase":"SEARCH|DISCUSSION","effect":"verify","once":true}]}}],
  "locations": [{"id":"地点id","name":"地点名","description":[内容块],"ownerCharacterId":"房间主人的角色id"}],
  "clues": [{"id":"线索id","locationId":"地点id","name":"线索名","category":"object|document|testimony|trace|medical|digital|other","content":[内容块],"policy":"auto_public|manual_public|keep_private","relatedCharacterIds":[],"relatedTruthEventIds":[],"forbiddenCharacterIds":[],"release":{"round":1,"afterCluePublicIds":[]}}],
  "truth": {"culpritId":"角色id","motive":[内容块],"method":{"summary":[内容块],"steps":[{"id":"id","title":"步骤","content":[内容块],"clueIds":[]}]},"timeline":[真相时间事件],"keyEvidenceIds":["线索id"],"evidenceChain":[{"id":"id","clueIds":["线索id","线索id"],"conclusion":"推论"}],"redHerrings":[],"supplemental":[],"reveal":[内容块]},
  "flow": { "selfIntroRounds": 1, "searchRounds": 2, "discussionRounds": 2, "allowPrivateChat": true, "privateChatMessageLimit": 3, "allowClueTransfer": false, "actionPointsPerRound": 0, "voteMode": "culprit|hybrid|choice", "acts": [{"id":"幕id","title":"幕名","brief":[内容块],"roundStart":1}] },
  "ending": { "outcomes": [{"result":"culprit_caught","title":"真凶被捕","content":[内容块]},{"result":"culprit_escaped","title":"真凶逃脱","content":[内容块]}], "quiz": [{"id":"题id","prompt":"题面","options":[{"id":"项id","label":"选项"}],"correctOptionId":"项id","weight":1}] },
  "hostGuide": { "perPhase": [{"phase":"READING|SELF_INTRO|SEARCH|DISCUSSION|VOTE","notes":"该阶段的主持要点"}], "stallBreakers": [{"condition":"卡关情形","hint":"扶车提示"}], "guaranteedPublicClues": [{"clueId":"关键线索id","deadlineRound":2}] }
}
内容块只能是 paragraph/list/quote，文本叶不要换行、Markdown 或 HTML；时间事件必须有 id、time.display、title、content，尽量提供 HH:mm 的 start/end。

硬性要求（违反会被入库校验拦下，请逐条自检）：
1) 真凶恰有一名且 privateCard.isCulprit=true、truth.culpritId=其 id；所有引用 ID 必须存在。
2) 每条线索的 locationId 必须存在；至少 3 张线索卡；给 1 张 auto_public 线索（死因）。
3) 线索池预算：线索总数不得超过「人数 × 搜证轮数」（5 人 × 2 轮 = 10 张），超出的线索永远搜不到。
4) 证据链：truth.evidenceChain 每条至少引用 2 条线索，且必须人证/物证交叉（testimony、document 类与 object、trace、medical、digital 类各至少一条）。
5) 不要把“知道某人的姓名”当作锁凶，也不得靠删除姓名来增加难度。无辜者可以在关系、目击和对话材料中明确提及其他角色。反例（禁止）：“你在走廊亲眼看见有人让服务员换酒”——姓名被抹掉后玩家只能说空话。正例（推荐）：“你亲眼看见林七在传菜口递钱让服务员换酒，你当时以为他在张罗酒水”——点名、只给可观察事实、并留出归因错的空间。单张卡不得同时给出 ①真凶姓名 ②加害行为 ③“明知/清楚/听见他说”式的主观状态；“能证明／不足以证明”这类判词写进 hostGuide 或 truth.evidenceChain[].conclusion，不要写进线索正文。
6) 时间线标题必须是该事件的内容摘要，禁止「事件 1」「事件 2」这类占位标题；正文要完整成句，不要截断半句。
7) voteMode=culprit 时 quiz 留空数组；hybrid/choice 时必须有题，且 correctOptionId 必须在 options 内。
8) 每个角色都有秘密/目标/时间线/persona；秘密 1-2 个（可有与案情弱相关的次级秘密增加可演性），至少一个用 disclosure="conditional" 并写清 condition（被逼问到什么/什么时机才承认），与角色 objectives 呼应。

可选增强（写了就生效，不写不影响入库）：分幕读本 acts + 角色 stages（acts[].brief 是主持手册，只进 DM 面板和 AI 主持上下文，不会念给玩家；要给玩家的本幕新知识写进 stages）、DM 手册 hostGuide、技能卡 skills（需同时把 flow.actionPointsPerRound 设为 >0）、线索转交 allowClueTransfer、线索发放计划 release / forbiddenCharacterIds、房间主人 ownerCharacterId、knowledge.kind 区分亲见/听说/推断、disclosure=must_share 表示"必须在合适时机主动交代"、alibi / violation / tells。

只输出 JSON，不要任何其他文本。`;

export const PLAYTEST_FLOW_HINT = "flow.interactionBeats 可配置 after_discussion 角色选择（id/round/characterId/prompt/choices[id,label,recap]/defaultChoiceId/visibility）。defenseHooks 优先使用 brokenWhen.allPublicClueIds（全部公开）或 anyPublicClueIds（任一公开）；保留旧 brokenByPublicClueIds 兼容。manual_public 保证材料必须有至少跨一轮的私藏窗口。";
