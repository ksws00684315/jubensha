import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { parseScriptDoc, publicScriptView } from "@/core/script/schema";
import ScriptDetail from "@/components/ScriptDetail";

export default async function ScriptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const script = await db.script.findFirst({ where: { id, deleted: false } });
  if (!script) notFound();
  const doc = parseScriptDoc(script.content);
  return (
    <ScriptDetail
      id={script.id}
      publicDoc={publicScriptView(doc)}
      source={script.source}
      updatedAt={script.updatedAt.toISOString()}
    />
  );
}
