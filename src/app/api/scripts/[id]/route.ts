import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestScriptDoc, parseScriptForRuntime } from "@/core/script/compat";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import { validateScriptV2 } from "@/core/script/v2/validate";
import { isAdminRequest, requireAdmin } from "@/lib/admin";

async function getScript(id: string) {
  return db.script.findFirst({ where: { id, deleted: false } });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const script = await getScript(id);
  if (!script) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseOrCanonical(script.content);
  const full = new URL(req.url).searchParams.get("full") === "1";
  if (full) {
    const denied = requireAdmin(req);
    if (denied) return denied;
    return NextResponse.json({
      id: script.id,
      source: script.source,
      updatedAt: script.updatedAt,
      issues: validateScriptV2(doc),
      doc,
    });
  }
  const publicView = publicScriptViewV2(doc);
  return NextResponse.json({
    id: script.id,
    source: script.source,
    updatedAt: script.updatedAt,
    public: publicView,
    structured: publicView,
    admin: isAdminRequest(req),
  });
}

/** 更新剧本（整体替换文档，需重新通过校验）。入库一律存 V2。 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  const docInput = body.doc ?? body;
  let ingested;
  try {
    ingested = ingestScriptDoc(docInput);
  } catch (err) {
    return NextResponse.json({ error: "剧本结构校验失败", issues: String(err).slice(0, 1000) }, { status: 400 });
  }
  const issues = [
    ...ingested.migrationWarnings.map((warning) => ({ level: "warning" as const, path: warning.path, message: warning.message })),
    ...validateScriptV2(ingested.doc),
  ];
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) return NextResponse.json({ error: "剧本逻辑校验失败", issues: errors }, { status: 400 });

  const script = await db.script.update({
    where: { id },
    data: {
      title: ingested.doc.meta.title,
      minPlayers: ingested.doc.meta.minPlayers,
      maxPlayers: ingested.doc.meta.maxPlayers,
      durationMin: ingested.doc.meta.durationMin,
      difficulty: ingested.doc.meta.difficulty,
      tags: ingested.doc.meta.tags,
      intro: ingested.doc.meta.intro,
      content: ingested.doc as unknown as object,
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
  const doc = parseOrCanonical(script.content);
  return new NextResponse(JSON.stringify(doc, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(script.title)}.json"`,
    },
  });
}

function parseOrCanonical(doc: unknown) {
  try {
    return parseScriptForRuntime(doc);
  } catch {
    return {
      version: 2 as const,
      meta: { title: "（结构损坏的剧本）", minPlayers: 0, maxPlayers: 0, durationMin: 0, difficulty: "新手" as const, tags: [], intro: "结构损坏" },
      background: [{ type: "paragraph" as const, text: "结构损坏" }],
      characters: [],
      locations: [],
      clues: [],
      truth: {
        culpritId: "unknown",
        motive: [],
        method: { summary: [{ type: "paragraph" as const, text: "结构损坏" }], steps: [] },
        timeline: [],
        keyEvidenceIds: [],
        evidenceChain: [],
        redHerrings: [],
        supplemental: [],
        reveal: [{ type: "paragraph" as const, text: "结构损坏" }],
      },
      flow: { selfIntroRounds: 1, searchRounds: 2, discussionRounds: 2, allowPrivateChat: false, privateChatMessageLimit: 3 },
      ending: {
        outcomes: [
          { result: "culprit_caught" as const, title: "损坏", content: [{ type: "paragraph" as const, text: "结构损坏" }] },
          { result: "culprit_escaped" as const, title: "损坏", content: [{ type: "paragraph" as const, text: "结构损坏" }] },
        ],
      },
    };
  }
}
