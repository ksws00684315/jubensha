import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { testProviderConnection } from "@/core/llm/client";
import { requireAdmin } from "@/lib/admin";

const testSchema = z.union([
  z.object({
    providerId: z.string().min(1),
    protocol: z.undefined().optional(),
    baseUrl: z.undefined().optional(),
    apiKey: z.undefined().optional(),
  }),
  z.object({
    providerId: z.undefined().optional(),
    protocol: z.enum(["openai_compatible", "anthropic"]),
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
  }),
]);

/** 测试连接：传 providerId 测已保存配置，或传 protocol/baseUrl/apiKey 测未保存的新配置 */
export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const parsed = testSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  let protocol: string;
  let baseUrl: string;
  let apiKey: string;
  if ("providerId" in parsed.data && parsed.data.providerId) {
    const p = await db.aiProvider.findUnique({ where: { id: parsed.data.providerId } });
    if (!p) return NextResponse.json({ error: "Provider 不存在" }, { status: 404 });
    protocol = p.protocol;
    baseUrl = p.baseUrl;
    apiKey = decryptSecret(p.apiKeyCipher);
  } else {
    protocol = (parsed.data as { protocol: string }).protocol;
    baseUrl = (parsed.data as { baseUrl: string }).baseUrl;
    apiKey = (parsed.data as { apiKey: string }).apiKey;
  }

  const result = await testProviderConnection({ protocol, baseUrl, apiKey });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
