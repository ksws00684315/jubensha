import { NextResponse } from "next/server";
import { z } from "zod";
import { chat, extractJson } from "@/core/llm/client";
import { scriptDocSchema } from "@/core/script/schema";
import { validateScript } from "@/core/script/validate";
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

const SCHEMA_HINT = `输出必须是一个 JSON 对象，结构如下（字段名固定）：
{
  "version": 1,
  "meta": { "title": "剧名", "minPlayers": 人数, "maxPlayers": 人数, "durationMin": 分钟数, "difficulty": "新手|进阶|硬核", "tags": ["标签"], "intro": "一句话简介" },
  "background": "公开背景故事（所有玩家可见，300-500字，包含死者、场景、发现经过、时间压力）",
  "characters": [ { "id": "小写拼音id", "name": "姓名", "gender": "男|女", "age": 数字,
      "publicBio": "公开身份一句话",
      "card": { "backstory": "私背景(150-300字, 第二人称'你')", "secret": "不可告人的秘密", "goal": "本局目标",
        "isCulprit": true/false, "timeline": "个人时间线(第二人称, 含具体时刻)", "knowledge": ["你亲眼所见/所知情报"], "persona": "说话风格" } } ],
  "locations": ["搜证地点1", "地点2", ...],
  "clues": [ { "id": "线索id", "location": "所属地点", "name": "线索名", "content": "线索卡文本(含可推理的细节)", "policy": "auto_public|manual_public|keep_private" } ],
  "truth": { "culprit": "真凶角色id", "method": "作案手法", "fullTimeline": "全场完整时间线(精确到时刻)", "keyEvidence": ["关键证据名"], "reveal": "复盘文本(200-400字)" },
  "flow": { "selfIntroRounds": 1, "searchRounds": 2, "discussionRounds": 2, "allowPrivateChat": true, "privateChatMessageLimit": 3 },
  "ending": { "winText": "胜负说明" }
}
硬性要求：真凶恰有一名且其 card.isCulprit=true、truth.culprit=其 id；每个角色都有秘密/目标/时间线/persona；每条线索的 location 必须在 locations 中；每张线索卡的 content 要与时间线互相印证；keyEvidence 中的证据必须有对应线索卡（名称呼应）；至少 3 张线索卡；给 1 张 auto_public 线索（死因）。只输出 JSON，不要任何其他文本。`;

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

    // 修正真凶 id 一致性后走 Zod 校验
    try {
      const anyDoc = doc as { characters?: Array<{ id?: string; isCulprit?: boolean }>; truth?: { culprit?: string } };
      const culpritChar = anyDoc.characters?.find((c) => c.isCulprit === true);
      if (culpritChar?.id && anyDoc.truth) anyDoc.truth.culprit = culpritChar.id;
    } catch {
      /* ignore */
    }
    const check = scriptDocSchema.safeParse(doc);
    if (!check.success) {
      const issues = check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 12);
      return NextResponse.json({ error: "生成结果未通过结构校验", issues, doc }, { status: 422 });
    }
    return NextResponse.json({ doc: check.data, issues: validateScript(check.data) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
