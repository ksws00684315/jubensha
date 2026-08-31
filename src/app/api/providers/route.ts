import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { encryptSecret, maskSecret } from "@/lib/crypto";
import { requireAdmin } from "@/lib/admin";

const createSchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(["openai_compatible", "anthropic"]),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  note: z.string().optional(),
});

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const providers = await db.aiProvider.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(
    providers.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeyMasked: maskSecret(p.apiKeyCipher),
      enabled: p.enabled,
      note: p.note,
    }))
  );
}

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数不合法", detail: parsed.error.flatten() }, { status: 400 });
  }
  const provider = await db.aiProvider.create({
    data: {
      name: parsed.data.name,
      protocol: parsed.data.protocol,
      baseUrl: parsed.data.baseUrl.replace(/\/$/, ""),
      apiKeyCipher: encryptSecret(parsed.data.apiKey),
      note: parsed.data.note ?? null,
    },
  });
  return NextResponse.json({ id: provider.id }, { status: 201 });
}
