import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScriptDoc, publicScriptView, type ScriptDocInput } from "@/core/script/schema";
import { validateScript } from "@/core/script/validate";
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
      issues: validateScript(parsed),
      doc: parsed,
    });
  }
  return NextResponse.json({
    id: script.id,
    source: script.source,
    updatedAt: script.updatedAt,
    public: publicScriptView(parsed),
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
  const docInput: ScriptDocInput = body.doc ?? body;
  let doc;
  try {
    doc = parseScriptDoc(docInput);
  } catch (err) {
    return NextResponse.json({ error: "剧本结构校验失败", issues: String(err).slice(0, 1000) }, { status: 400 });
  }
  const errors = validateScript(doc).filter((i) => i.level === "error");
  if (errors.length) return NextResponse.json({ error: "剧本逻辑校验失败", issues: errors }, { status: 400 });

  const script = await db.script.update({
    where: { id },
    data: {
      title: doc.meta.title,
      minPlayers: doc.meta.minPlayers,
      maxPlayers: doc.meta.maxPlayers,
      durationMin: doc.meta.durationMin,
      difficulty: doc.meta.difficulty,
      tags: doc.meta.tags,
      intro: doc.meta.intro,
      content: doc as unknown as object,
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
    return parseScriptDoc(doc);
  } catch {
    // 旧数据容错：结构坏了也让详情页能打开（校验结果里会报 error）
    return {
      version: 1,
      meta: { title: "（结构损坏的剧本）", minPlayers: 0, maxPlayers: 0, durationMin: 0, difficulty: "新手", tags: [], intro: "" },
      background: "",
      characters: [],
      locations: [],
      clues: [],
      truth: { culprit: "", method: "", fullTimeline: "", keyEvidence: [], reveal: "" },
      flow: {},
      ending: { winText: "" },
    } as unknown as ReturnType<typeof parseScriptDoc>;
  }
}
