import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

/** 用量统计：按 provider+model+purpose 汇总（近 30 天） */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const rows = await db.usageLog.groupBy({
    by: ["providerName", "modelId", "purpose", "ok"],
    where: { createdAt: { gte: since } },
    _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
    _count: { _all: true },
  });
  const recentErrors = await db.usageLog.findMany({
    where: { ok: false, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { providerName: true, modelId: true, purpose: true, error: true, createdAt: true },
  });
  const summary = rows.map((r) => ({
    providerName: r.providerName,
    modelId: r.modelId,
    purpose: r.purpose,
    ok: r.ok,
    calls: r._count._all,
    promptTokens: r._sum.promptTokens ?? 0,
    completionTokens: r._sum.completionTokens ?? 0,
    totalTokens: r._sum.totalTokens ?? 0,
  }));
  return NextResponse.json({ since: since.toISOString(), summary, recentErrors });
}
