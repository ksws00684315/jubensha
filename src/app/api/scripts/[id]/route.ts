import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestScriptDoc, parseScriptForRuntime } from "@/core/script/compat";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import { validateScriptV2 } from "@/core/script/v2/validate";
import { isAdminRequest, requireAdmin } from "@/lib/admin";
import { authorDesignPackageSchema, designPackageHash, validateAuthorDesignPackage } from "@/core/script/design";

async function getScript(id: string) {
  return db.script.findFirst({ where: { id, deleted: false } });
}

async function GET_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
      designPackage: script.designPackage,
      designHash: script.designHash,
      designReview: script.designReview,
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
async function PATCH_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const existing = await getScript(id);
  if (!existing) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
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

  const designParsed = body.designPackage === undefined ? null : authorDesignPackageSchema.safeParse(body.designPackage);
  if (designParsed && !designParsed.success) return NextResponse.json({ error: "作者设计包结构校验失败", issues: designParsed.error.issues }, { status: 400 });
  const designIssues = designParsed?.success ? validateAuthorDesignPackage(designParsed.data, ingested.doc) : [];
  if (designIssues.some((issue) => issue.level === "error")) return NextResponse.json({ error: "作者设计包引用校验失败", issues: designIssues }, { status: 400 });

  // 审稿门禁：新设计包或库里既有审稿记录标着 needs_revision，且仍有 error 级问题 → 不 force 就退回
  const reviewStatus = (designParsed?.success ? designParsed.data.review.status : undefined) ?? (existing.designReview as { status?: string } | null)?.status;
  if (reviewStatus === "needs_revision" && errors.length && body.force !== true) {
    return NextResponse.json(
      { error: "审稿结论为 needs_revision 且仍有 error 级问题未处理：请先修改，确认无误再带 force:true 强制入库", issues: errors },
      { status: 409 },
    );
  }
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
      ...(designParsed?.success ? { designPackage: designParsed.data as unknown as object, designHash: designPackageHash(designParsed.data) } : {}),
      ...(!designParsed?.success && existing.designReview
        ? { designReview: { ...(existing.designReview as Record<string, unknown>), status: "needs_revision", staleReason: "正文已修改，需重新审稿" } as object }
        : {}),
    },
  });
  return NextResponse.json({ id: script.id, issues: [...issues, ...designIssues] });
}

async function DELETE_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  await db.script.update({ where: { id }, data: { deleted: true } }).catch(() => null);
  return NextResponse.json({ ok: true });
}

/** 导出 JSON */
async function POST_IMPL(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
      flow: { selfIntroRounds: 1, searchRounds: 2, discussionRounds: 2, allowPrivateChat: false, privateChatMessageLimit: 3, allowClueTransfer: false, actionPointsPerRound: 0, voteMode: "culprit" as const, acts: [] },
      ending: {
        quiz: [],
        outcomes: [
          { result: "culprit_caught" as const, title: "损坏", content: [{ type: "paragraph" as const, text: "结构损坏" }] },
          { result: "culprit_escaped" as const, title: "损坏", content: [{ type: "paragraph" as const, text: "结构损坏" }] },
        ],
      },
    };
  }
}

export const GET = withRoute(GET_IMPL);
export const PATCH = withRoute(PATCH_IMPL);
export const DELETE = withRoute(DELETE_IMPL);
export const POST = withRoute(POST_IMPL);
