import { withRoute } from "@/lib/api";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScriptForRuntime } from "@/core/script/compat";
import { buildSeatView } from "@/core/engine/seat-view";
import { GameEngine } from "@/core/engine/engine";
import { verifySeatToken } from "@/lib/credentials";
import type { GameState } from "@/core/engine/types";

/** 对局概要：阶段、座位、我的角色卡（按 token 鉴权） */
async function GET_IMPL(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const seatParam = url.searchParams.get("seat");
  // 凭证优先走 header（不进访问日志）；query 为兼容期回退，一个版本后删除
  const token =
    req.headers.get("x-seat-token") ?? url.searchParams.get("token");

  const game = await db.game.findUnique({
    where: { id },
    include: {
      room: { include: { seats: { orderBy: { index: "asc" } } } },
      script: true,
    },
  });
  if (!game) return NextResponse.json({ error: "对局不存在" }, { status: 404 });

  // 快照优先；快照或原始剧本任一可解析即可提供服务，全部损坏时降级 503 而不是抛 500
  let doc: ReturnType<typeof parseScriptForRuntime>;
  try {
    doc = parseScriptForRuntime(game.scriptSnapshot ?? game.script.content);
  } catch {
    try {
      doc = parseScriptForRuntime(game.script.content);
    } catch {
      return NextResponse.json(
        { error: "对局剧本数据损坏，请联系主持人" },
        { status: 503 },
      );
    }
  }

  let mySeat: number | null = seatParam !== null ? Number(seatParam) : null;
  if (!verifySeatToken(game.room.seats, mySeat, token)) mySeat = null;

  // 只有持有有效座位凭证的参与者才可触发懒恢复；公开观战请求只读快照，避免被匿名轮询唤醒 AI 消耗。
  if (game.status === "running" && mySeat !== null && !GameEngine.get(id)) {
    void GameEngine.load(id).catch(() => null);
  }
  const runtimeState = (game.state as unknown as GameState) ?? {
    clueStates: {},
    heldClues: {},
  };
  return NextResponse.json(buildSeatView({ game, doc, runtimeState, mySeat }));
}

export const GET = withRoute(GET_IMPL);
