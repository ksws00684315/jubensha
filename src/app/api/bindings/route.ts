import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { BINDING_SLOT_KEYS } from "@/lib/provider-presets";
import { MAX_BINDING_OUTPUT_TOKENS, MIN_BINDING_OUTPUT_TOKENS } from "@/core/llm/output-tokens";

const slotSchema = z.enum(BINDING_SLOT_KEYS);

const upsertSchema = z.object({
  slot: slotSchema,
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(MIN_BINDING_OUTPUT_TOKENS).max(MAX_BINDING_OUTPUT_TOKENS).nullable().optional(),
  contextWindow: z.number().int().min(1024).max(2_000_000).nullable().optional(),
  supportsSystem: z.boolean().optional(),
  supportsJson: z.boolean().optional(),
  fallbackSlot: slotSchema.nullable().optional(),
});

async function GET_IMPL(req: Request) {
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
      maxTokens: b.maxTokens,
      contextWindow: b.contextWindow,
      supportsSystem: b.supportsSystem,
      detectedSystemSupport: b.detectedSystemSupport,
      capabilityDetectedAt: b.capabilityDetectedAt,
      actualMessageMode: b.supportsSystem && b.detectedSystemSupport !== false ? "system" : "merged_user",
      supportsJson: b.supportsJson,
      fallbackSlot: b.fallbackSlot,
      providerEnabled: b.provider.enabled,
    }))
  );
}

async function PUT_IMPL(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  const d = parsed.data;
  const provider = await db.aiProvider.findUnique({ where: { id: d.providerId } });
  if (!provider) return NextResponse.json({ error: "Provider 不存在" }, { status: 404 });
  if (!provider.enabled) return NextResponse.json({ error: "该 Provider 已被禁用" }, { status: 400 });

  const previous = await db.modelBinding.findUnique({ where: { slot: d.slot } });
  const changedModel = previous?.providerId !== d.providerId || previous?.modelId !== d.modelId;
  const binding = await db.modelBinding.upsert({
    where: { slot: d.slot },
    create: {
      slot: d.slot,
      providerId: d.providerId,
      modelId: d.modelId,
      temperature: d.temperature ?? null,
      maxTokens: d.maxTokens ?? null,
      contextWindow: d.contextWindow ?? null,
      supportsSystem: d.supportsSystem ?? true,
      supportsJson: d.supportsJson ?? false,
      fallbackSlot: d.fallbackSlot ?? null,
    },
    update: {
      ...(changedModel ? { detectedSystemSupport: null, capabilityDetectedAt: null } : {}),
      providerId: d.providerId,
      modelId: d.modelId,
      ...(d.temperature !== undefined ? { temperature: d.temperature } : {}),
      ...(d.maxTokens !== undefined ? { maxTokens: d.maxTokens } : {}),
      ...(d.contextWindow !== undefined ? { contextWindow: d.contextWindow } : {}),
      ...(d.supportsSystem !== undefined ? { supportsSystem: d.supportsSystem } : {}),
      ...(d.supportsJson !== undefined ? { supportsJson: d.supportsJson } : {}),
      ...(d.fallbackSlot !== undefined ? { fallbackSlot: d.fallbackSlot } : {}),
    },
  });
  return NextResponse.json({ slot: binding.slot });
}

export const GET = withRoute(GET_IMPL);
export const PUT = withRoute(PUT_IMPL);
