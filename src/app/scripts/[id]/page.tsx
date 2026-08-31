import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { parseScriptForRuntime } from "@/core/script/compat";
import { publicScriptViewV2 } from "@/core/script/v2/schema";
import ScriptDetail from "@/components/ScriptDetail";

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const script = await db.script.findFirst({ where: { id, deleted: false } });
  if (!script) notFound();
  const doc = parseScriptForRuntime(script.content);
  return (
    <ScriptDetail
      id={script.id}
      publicDocV2={publicScriptViewV2(doc)}
      source={script.source}
      updatedAt={script.updatedAt.toISOString()}
    />
  );
}
