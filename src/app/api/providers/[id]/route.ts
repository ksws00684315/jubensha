import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { requireAdmin } from "@/lib/admin";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  protocol: z.enum(["openai_compatible", "anthropic"]).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }
  const existing = await db.aiProvider.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Provider 不存在" }, { status: 404 });
  const provider = await db.aiProvider.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.protocol !== undefined ? { protocol: parsed.data.protocol } : {}),
      ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl.replace(/\/$/, "") } : {}),
      ...(parsed.data.apiKey !== undefined ? { apiKeyCipher: encryptSecret(parsed.data.apiKey) } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
    },
  });
  return NextResponse.json({ id: provider.id, apiKeyMasked: maskSecret(provider.apiKeyCipher) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  await db.aiProvider.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
