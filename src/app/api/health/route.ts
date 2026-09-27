import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { engines } from "@/core/engine/registry";
import { heldLeaseCount } from "@/core/engine/lease";
import { dailyTokenBudget, usedTokensToday } from "@/core/llm/budget";
import { db } from "@/lib/db";

const DB_TIMEOUT_MS = 1_000;

async function databaseIsUp(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const ping = db.$queryRaw`SELECT 1`;
    await Promise.race([
      ping,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Database ping timed out")), DB_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function oldestStuckPhaseSec(): number {
  const now = Date.now();
  let oldest = 0;
  for (const engine of engines.values()) {
    const lastEvent = engine.events.at(-1)?.createdAt;
    if (!lastEvent) continue;
    const at = Date.parse(lastEvent);
    if (!Number.isFinite(at)) continue;
    oldest = Math.max(oldest, Math.floor(Math.max(0, now - at) / 1_000));
  }
  return oldest;
}

async function GET_IMPL(req: Request): Promise<Response> {
  const up = await databaseIsUp();
  if (!up) {
    return NextResponse.json({ ok: false, db: "down", uptimeSec: Math.floor(process.uptime()) }, { status: 503 });
  }

  const publicStatus = { ok: true, db: "up", uptimeSec: Math.floor(process.uptime()) };
  const denied = requireAdmin(req);
  if (denied) return NextResponse.json(publicStatus);

  return NextResponse.json({
    ...publicStatus,
    engines: engines.size,
    leasesHeld: heldLeaseCount(),
    oldestStuckPhaseSec: oldestStuckPhaseSec(),
    budget: { used: await usedTokensToday(), limit: dailyTokenBudget() },
  });
}

export const GET = withRoute(GET_IMPL);
