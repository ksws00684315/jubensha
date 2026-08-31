import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { locationNames, parseScriptForRuntime, publicBioText } from "@/core/script/compat";
import { validateScriptV2 } from "@/core/script/v2/validate";

/** 剧本公开元数据（不含真相/角色私卡），供开房间等客户端场景使用 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const script = await db.script.findFirst({ where: { id, deleted: false } });
  if (!script) return NextResponse.json({ error: "剧本不存在" }, { status: 404 });
  const doc = parseScriptForRuntime(script.content);
  return NextResponse.json({
    id: script.id,
    title: doc.meta.title,
    intro: doc.meta.intro,
    minPlayers: doc.meta.minPlayers,
    maxPlayers: doc.meta.maxPlayers,
    difficulty: doc.meta.difficulty,
    durationMin: doc.meta.durationMin,
    tags: doc.meta.tags,
    locations: locationNames(doc),
    characters: doc.characters.map((c) => ({ id: c.id, name: c.name, publicBio: publicBioText(c) })),
    issues: validateScriptV2(doc).filter((i) => i.level === "error"),
  });
}
