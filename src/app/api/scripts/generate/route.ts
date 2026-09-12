import { NextResponse } from "next/server";
import { z } from "zod";
import { chat, extractJson } from "@/core/llm/client";
import { cacheFriendlyMessages, GENERATOR_SYSTEM } from "@/core/agents/context";
import { ingestScriptDoc } from "@/core/script/compat";
import { parseScriptDocV2, scriptDocV2Schema } from "@/core/script/v2/schema";
import { validateScriptV2 } from "@/core/script/v2/validate";
import { requireAdmin } from "@/lib/admin";

const reqSchema = z.object({
  stage: z.union([z.literal(1), z.literal(2)]),
  theme: z.string().max(200).optional(),
  playerCount: z.number().int().min(3).max(8).optional(),
  difficulty: z.enum(["新手", "进阶", "硬核"]).optional(),
  trickType: z.string().max(60).optional(),
  extra: z.string().max(500).optional(),
  /** stage=2 时传入 stage1 的产物 */
  outline: z.unknown().optional(),
});

const SCHEMA_HINT = `输出必须是一个 JSON 对象，version 固定为 2，结构如下（字段名固定）：
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
  "hostGuide": { "perPhase": [{"phase":"READING|SELF_INTRO|SEARCH|DISCUSSION|VOTE","notes":"该阶段的主持要点"}], "stallBreakers": [{"condition":"卡关情形","hint":"扶车提示"}] }
}
内容块只能是 paragraph/list/quote，文本叶不要换行、Markdown 或 HTML；时间事件必须有 id、time.display、title、content，尽量提供 HH:mm 的 start/end。

硬性要求（违反会被入库校验拦下，请逐条自检）：
1) 真凶恰有一名且 privateCard.isCulprit=true、truth.culpritId=其 id；所有引用 ID 必须存在。
2) 每条线索的 locationId 必须存在；至少 3 张线索卡；给 1 张 auto_public 线索（死因）。
3) 线索池预算：线索总数不得超过「人数 × 搜证轮数」（5 人 × 2 轮 = 10 张），超出的线索永远搜不到。
4) 证据链：truth.evidenceChain 每条至少引用 2 条线索，且必须人证/物证交叉（testimony、document 类与 object、trace、medical、digital 类各至少一条）。
5) 无辜者的角色卡任何通道（knowledge / secrets / objectives / backstory / timeline / alibi）都不得出现真凶姓名，否则玩家读卡即锁凶。
6) 时间线标题必须是该事件的内容摘要，禁止「事件 1」「事件 2」这类占位标题；正文要完整成句，不要截断半句。
7) voteMode=culprit 时 quiz 留空数组；hybrid/choice 时必须有题，且 correctOptionId 必须在 options 内。
8) 每个角色都有秘密/目标/时间线/persona；秘密 1-2 个（可有与案情弱相关的次级秘密增加可演性），至少一个用 disclosure="conditional" 并写清 condition（被逼问到什么/什么时机才承认），与角色 objectives 呼应。

可选增强（写了就生效，不写不影响入库）：分幕读本 acts + 角色 stages、DM 手册 hostGuide、技能卡 skills（需同时把 flow.actionPointsPerRound 设为 >0）、线索转交 allowClueTransfer、线索发放计划 release / forbiddenCharacterIds、房间主人 ownerCharacterId、knowledge.kind 区分亲见/听说/推断、disclosure=must_share 表示"必须在合适时机主动交代"、alibi / violation / tells。

只输出 JSON，不要任何其他文本。`;

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const parsed = reqSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  const d = parsed.data;

  try {
    if (d.stage === 1) {
      const res = await chat({
        purpose: "generator",
        messages: cacheFriendlyMessages(
          GENERATOR_SYSTEM,
          "【任务】先产出剧本骨架。只输出 JSON：{\"title\",\"intro\",\"background\",\"locations\":[\"地点\"],\"victim\":{\"name\",\"identity\",\"discovery\"},\"characters\":[{\"name\",\"gender\",\"age\",\"publicBio\",\"isCulprit\",\"secretIdea\"}],\"methodSummary\",\"timelineSketch\"}。characters 数量必须等于玩家人数；恰有一名 isCulprit=true；timelineSketch 给出案发夜完整时间线草稿（精确到时刻）。background 300-400字。",
          `题材：${d.theme ?? "现代都市悬疑"}；玩家人数：${d.playerCount ?? 5}；难度：${d.difficulty ?? "新手"}；诡计偏好：${d.trickType ?? "本格叙述性误导（不用超自然）"}；其他要求：${d.extra ?? "无"}`
        ),
        temperature: 0.9,
      });
      const outline = extractJson(res.text);
      if (!outline) return NextResponse.json({ error: "模型未返回合法 JSON，请重试" }, { status: 502 });
      return NextResponse.json({ outline });
    }

    // stage 2：根据骨架产出完整剧本
    const players = d.playerCount ?? 5;
    const res = await chat({
      purpose: "generator",
      messages: cacheFriendlyMessages(
        GENERATOR_SYSTEM,
        `【任务】根据骨架写出完整剧本文档。\n${SCHEMA_HINT}`,
        // 线索数量按 R1 预算给出口径：此前写死"8-14 张"与「人数×轮数」上限冲突，生成结果常被校验拦下
        `剧本骨架：\n${JSON.stringify(d.outline, null, 2)}\n\n请输出完整剧本文档 JSON。人物 id 用其姓名的小写拼音。线索数量按「人数 × 搜证轮数」取（例如 ${players} 人 × 2 轮 = ${players * 2} 张），不得超过该上限，且每一张都要真的能被搜到。`
      ),
      temperature: 0.8,
    });
    const doc = extractJson(res.text);
    if (!doc) return NextResponse.json({ error: "模型未返回合法 JSON，请重试" }, { status: 502 });

    if (typeof doc === "object" && doc !== null && (doc as { version?: unknown }).version !== 1) {
      try {
        const anyDoc = doc as { characters?: Array<{ id?: string; privateCard?: { isCulprit?: boolean } }>; truth?: { culpritId?: string } };
        const culpritChar = anyDoc.characters?.find((c) => c.privateCard?.isCulprit === true);
        if (culpritChar?.id && anyDoc.truth) anyDoc.truth.culpritId = culpritChar.id;
      } catch {
        /* ignore */
      }
      const check = scriptDocV2Schema.safeParse(doc);
      if (!check.success) {
        return NextResponse.json(
          {
            error: "生成结果未通过结构校验",
            issues: check.error.issues.map((issue) => ({
              level: "error" as const,
              path: issue.path.join("."),
              message: issue.message,
            })),
            doc,
          },
          { status: 422 },
        );
      }
      const normalized = parseScriptDocV2(check.data);
      return NextResponse.json({ doc: normalized, issues: validateScriptV2(normalized) });
    }

    const ingested = ingestScriptDoc(doc);
    return NextResponse.json({
      doc: ingested.doc,
      issues: [
        ...ingested.migrationWarnings.map((warning) => ({ level: "warning" as const, path: warning.path, message: warning.message })),
        ...validateScriptV2(ingested.doc),
      ],
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
