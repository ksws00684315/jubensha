import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

const upsertSchema = z.object({
  slot: z.enum(["dm", "culprit", "player", "generator", "tts"]),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).nullable().optional(),
  fallbackSlot: z.enum(["dm", "culprit", "player", "generator", "tts"]).nullable().optional(),
});

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const bindings = await db.modelBinding.findMany({ include: { provider: true }, orderBy: { slot: "asc" } });
  return NextResponse.json(
    bindings.map((b) => ({
      slot: b.slot,
      providerId: b.providerId,
      providerName: b.provider.name,
      modelId: b.modelId,
      temperature: b.temperature,
      fallbackSlot: b.fallbackSlot,
      providerEnabled: b.provider.enabled,
    }))
  );
}

export async function PUT(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  const d = parsed.data;
  const provider = await db.aiProvider.findUnique({ where: { id: d.providerId } });
  if (!provider) return NextResponse.json({ error: "Provider 不存在" }, { status: 404 });
  if (!provider.enabled) return NextResponse.json({ error: "该 Provider 已被禁用" }, { status: 400 });

  const binding = await db.modelBinding.upsert({
    where: { slot: d.slot },
    create: {
      slot: d.slot,
      providerId: d.providerId,
      modelId: d.modelId,
      temperature: d.temperature ?? null,
      fallbackSlot: d.fallbackSlot ?? null,
    },
    update: {
      providerId: d.providerId,
      modelId: d.modelId,
      ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
      ...(d.fallbackSlot !== undefined ? { fallbackSlot: d.fallbackSlot } : {}),
    },
  });
  return NextResponse.json({ slot: binding.slot });
}
