import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { legacyScriptDocOf, parseAnyScriptDoc } from "@/core/script/compat";
import { publicScriptView } from "@/core/script/schema";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import ScriptDetail from "@/components/ScriptDetail";

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const script = await db.script.findFirst({ where: { id, deleted: false } });
  if (!script) notFound();
  const parsed = parseAnyScriptDoc(script.content);
  const legacy = legacyScriptDocOf(parsed.doc);
  return (
    <ScriptDetail
      id={script.id}
      publicDoc={publicScriptView(legacy)}
      publicDocV2={parsed.version === 2 ? publicScriptViewV2(parsed.doc) : null}
      source={script.source}
      updatedAt={script.updatedAt.toISOString()}
    />
  );
}
