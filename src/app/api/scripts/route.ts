import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestScriptDoc } from "@/core/script/compat";
import { validateScriptV2 } from "@/core/script/v2/validate";
import { requireAdmin } from "@/lib/admin";

/** 剧本列表（仅元数据） */
export async function GET() {
  const scripts = await db.script.findMany({
    where: { deleted: false },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      minPlayers: true,
      maxPlayers: true,
      durationMin: true,
      difficulty: true,
      tags: true,
      intro: true,
      source: true,
      updatedAt: true,
    },
  });
  return NextResponse.json(scripts);
}

/** 导入/创建剧本：body = { doc: ScriptDocV2 | V1, source? } 或直接是剧本文档。入库一律存 V2。 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  const docInput = typeof body === "object" && body !== null && "doc" in body ? body.doc : body;
  const source = typeof body?.source === "string" && ["manual", "ai", "import"].includes(body.source) ? body.source : "import";

  const ingested = ingestScriptDocSafe(docInput);
  if (!ingested.ok) {
    return NextResponse.json({ error: "剧本结构校验失败", issues: ingested.issues }, { status: 400 });
  }
  const doc = ingested.doc;
  const issues = [
    ...ingested.migrationWarnings.map((warning) => ({ level: "warning" as const, path: warning.path, message: warning.message })),
    ...validateScriptV2(doc),
  ];
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    return NextResponse.json({ error: "剧本逻辑校验失败", issues }, { status: 400 });
  }

  const script = await db.script.create({
    data: {
      title: doc.meta.title,
      minPlayers: doc.meta.minPlayers,
      maxPlayers: doc.meta.maxPlayers,
      durationMin: doc.meta.durationMin,
      difficulty: doc.meta.difficulty,
      tags: doc.meta.tags,
      intro: doc.meta.intro,
      content: doc as unknown as object,
      source,
    },
  });
  return NextResponse.json({ id: script.id, issues }, { status: 201 });
}

function ingestScriptDocSafe(input: unknown) {
  try {
    return { ok: true as const, ...ingestScriptDoc(input) };
  } catch (err) {
    const issues: Array<{ level: "error" | "warning"; message: string }> = [];
    if (err && typeof err === "object" && "issues" in err) {
      for (const issue of (err as { issues: Array<{ path: Array<string | number>; message: string }> }).issues) {
        issues.push({ level: "error", message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      }
    } else {
      issues.push({ level: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return { ok: false as const, issues };
  }
}
