import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { chat, extractJson } from "@/core/llm/client";
import { cacheFriendlyMessages, GENERATOR_SYSTEM } from "@/core/agents/context";
import { ingestScriptDoc } from "@/core/script/compat";
import { parseScriptDocV2, scriptDocV2Schema } from "@/core/script/v2/schema";
import { validateScriptV2 } from "@/core/script/v2/validate";
import { SCHEMA_HINT } from "@/core/script/schema-hint";
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


async function POST_IMPL(req: Request) {
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

export const POST = withRoute(POST_IMPL);
