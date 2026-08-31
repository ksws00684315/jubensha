import { NextResponse } from "next/server";
import { z } from "zod";
import { chat, extractJson } from "@/core/llm/client";
import { parseScriptDoc } from "@/core/script/schema";
import { migrateV1ToV2 } from "@/core/script/v2/migrate-v1";
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
  "characters": [{ "id":"小写拼音id", "name":"姓名", "publicProfile":{"identity":"公开身份", "bio":[内容块], "relationships":[{"characterId":"id","label":"关系"}]}, "privateCard":{"backstory":[内容块], "secrets":[{"id":"id","title":"秘密标题","content":[内容块],"disclosure":"never|conditional","condition":"条件"}], "objectives":[{"id":"id","title":"目标标题","content":[内容块],"priority":"primary|secondary"}], "timeline":[时间事件], "knowledge":[{"id":"id","title":"情报标题","content":[内容块],"source":"witnessed|heard|possessed|inferred|other","relatedCharacterIds":[],"relatedClueIds":[]}], "relationships":[], "persona":{"traits":[],"speechStyle":"说话风格","habits":[],"taboos":[]}, "isCulprit":true/false}}],
  "locations": [{"id":"地点id","name":"地点名","description":[内容块]}],
  "clues": [{"id":"线索id","locationId":"地点id","name":"线索名","category":"object|document|testimony|trace|medical|digital|other","content":[内容块],"policy":"auto_public|manual_public|keep_private","relatedCharacterIds":[],"relatedTruthEventIds":[]}],
  "truth": {"culpritId":"角色id","motive":[内容块],"method":{"summary":[内容块],"steps":[{"id":"id","title":"步骤","content":[内容块],"clueIds":[]}]},"timeline":[真相时间事件],"keyEvidenceIds":["线索id"],"evidenceChain":[{"id":"id","clueIds":["线索id"],"conclusion":"推论"}],"redHerrings":[],"supplemental":[],"reveal":[内容块]},
  "flow": { "selfIntroRounds": 1, "searchRounds": 2, "discussionRounds": 2, "allowPrivateChat": true, "privateChatMessageLimit": 3 },
  "ending": { "outcomes": [{"result":"culprit_caught","title":"真凶被捕","content":[内容块]},{"result":"culprit_escaped","title":"真凶逃脱","content":[内容块]}] }
}
内容块只能是 paragraph/list/quote，文本叶不要换行、Markdown 或 HTML；时间事件必须有 id、time.display、title、content，尽量提供 HH:mm 的 start/end。硬性要求：真凶恰有一名且 privateCard.isCulprit=true、truth.culpritId=其 id；所有引用 ID 必须存在；每个角色都有秘密/目标/时间线/persona；每条线索的 locationId 必须存在；keyEvidenceIds 和 evidenceChain 必须引用线索 ID；至少 3 张线索卡；给 1 张 auto_public 线索（死因）。只输出 JSON，不要任何其他文本。`;

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
        messages: [
          {
            role: "system",
            content:
              "你是资深剧本杀作者。请根据用户需求先产出剧本骨架。只输出 JSON：{\"title\",\"intro\",\"background\",\"locations\":[\"地点\"],\"victim\":{\"name\",\"identity\",\"discovery\"},\"characters\":[{\"name\",\"gender\",\"age\",\"publicBio\",\"isCulprit\",\"secretIdea\"}],\"methodSummary\",\"timelineSketch\"}。characters 数量必须等于玩家人数；恰有一名 isCulprit=true；timelineSketch 给出案发夜完整时间线草稿（精确到时刻，谁在何时见过死者）。background 300-400字。",
          },
          {
            role: "user",
            content: `题材：${d.theme ?? "现代都市悬疑"}；玩家人数：${d.playerCount ?? 5}；难度：${d.difficulty ?? "新手"}；诡计偏好：${d.trickType ?? "本格叙述性误导（不用超自然）"}；其他要求：${d.extra ?? "无"}`,
          },
        ],
        temperature: 0.9,
        maxTokens: 2500,
      });
      const outline = extractJson(res.text);
      if (!outline) return NextResponse.json({ error: "模型未返回合法 JSON，请重试" }, { status: 502 });
      return NextResponse.json({ outline });
    }

    // stage 2：根据骨架产出完整剧本
    const res = await chat({
      purpose: "generator",
      messages: [
        { role: "system", content: `你是资深剧本杀作者。根据给定骨架写出完整剧本文档。\n${SCHEMA_HINT}` },
        {
          role: "user",
          content: `剧本骨架：\n${JSON.stringify(d.outline, null, 2)}\n\n请输出完整剧本文档 JSON。人物 id 用其姓名的小写拼音。线索 8-14 张。`,
        },
      ],
      temperature: 0.8,
      maxTokens: 8000,
    });
    const doc = extractJson(res.text);
    if (!doc) return NextResponse.json({ error: "模型未返回合法 JSON，请重试" }, { status: 502 });

    let normalized;
    let migrationIssues: Array<{ level: "warning"; message: string }> = [];
    if (typeof doc === "object" && doc !== null && (doc as { version?: unknown }).version === 1) {
      const v1 = parseScriptDoc(doc);
      const migrated = migrateV1ToV2(v1);
      normalized = migrated.doc;
      migrationIssues = migrated.warnings.map((warning) => ({ level: "warning" as const, message: `${warning.path}: ${warning.message}` }));
    } else {
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
      normalized = parseScriptDocV2(check.data);
    }
    return NextResponse.json({ doc: normalized, issues: [...migrationIssues, ...validateScriptV2(normalized)] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
