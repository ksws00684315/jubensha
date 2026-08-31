import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseAnyScriptDoc } from "@/core/script/compat";
import { publicScriptView } from "@/core/script/schema";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import { validateScript } from "@/core/script/validate";
import { validateScriptV2 } from "@/core/script/v2/validate";
import { isAdminRequest, requireAdmin } from "@/lib/admin";

async function getScript(id: string) {
  return db.script.findFirst({ where: { id, deleted: false } });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const script = await getScript(id);
  if (!script) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const parsed = parseOrRaw(script.content);
  const full = new URL(req.url).searchParams.get("full") === "1";
  if (full) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    return NextResponse.json({
      id: script.id,
      source: script.source,
      updatedAt: script.updatedAt,
      issues: parsed.version === 2 ? validateScriptV2(parsed.doc) : validateScript(parsed.doc),
      doc: parsed.doc,
    });
  }
  return NextResponse.json({
    id: script.id,
    source: script.source,
    updatedAt: script.updatedAt,
    public: parsed.version === 2 ? publicScriptViewV2(parsed.doc) : publicScriptView(parsed.doc),
    structured: parsed.version === 2 ? publicScriptViewV2(parsed.doc) : null,
    admin: isAdminRequest(req),
  });
}

/** 更新剧本（整体替换文档，需重新通过校验） */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  const docInput = body.doc ?? body;
  let parsed;
  try {
    parsed = parseAnyScriptDoc(docInput);
  } catch (err) {
    return NextResponse.json({ error: "剧本结构校验失败", issues: String(err).slice(0, 1000) }, { status: 400 });
  }
  const issues = parsed.version === 2 ? validateScriptV2(parsed.doc) : validateScript(parsed.doc).map((issue) => ({ ...issue, path: "" }));
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) return NextResponse.json({ error: "剧本逻辑校验失败", issues: errors }, { status: 400 });

  const script = await db.script.update({
    where: { id },
    data: {
      title: parsed.doc.meta.title,
      minPlayers: parsed.doc.meta.minPlayers,
      maxPlayers: parsed.doc.meta.maxPlayers,
      durationMin: parsed.doc.meta.durationMin,
      difficulty: parsed.doc.meta.difficulty,
      tags: parsed.doc.meta.tags,
      intro: parsed.doc.meta.intro,
      content: parsed.doc as unknown as object,
    },
  });
  return NextResponse.json({ id: script.id });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  await db.script.update({ where: { id }, data: { deleted: true } }).catch(() => null);
  return NextResponse.json({ ok: true });
}

/** 导出 JSON */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const script = await getScript(id);
  if (!script) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  return new NextResponse(JSON.stringify(script.content, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(script.title)}.json"`,
    },
  });
}

function parseOrRaw(doc: unknown) {
  try {
    return parseAnyScriptDoc(doc);
  } catch {
    // 旧数据容错：结构坏了也让详情页能打开（校验结果里会报 error）
    return {
      version: 1 as const,
      doc: {
        version: 1,
        meta: { title: "（结构损坏的剧本）", minPlayers: 0, maxPlayers: 0, durationMin: 0, difficulty: "新手", tags: [], intro: "" },
        background: "",
        characters: [],
        locations: [],
        clues: [],
        truth: { culprit: "", method: "", fullTimeline: "", keyEvidence: [], reveal: "" },
        flow: {},
        ending: { winText: "" },
      } as unknown as ReturnType<typeof import("@/core/script/schema").parseScriptDoc>,
    };
  }
}
