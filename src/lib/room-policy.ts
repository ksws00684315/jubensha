import { NextResponse } from "next/server";
import { isAdminRequest, safeEqualString } from "@/lib/admin";

/** 开房授权策略（决策 D2）。 */
export type RoomCreatePolicy = "open" | "admin" | "invite";

/**
 * 生产默认 `admin`：AI 座位会真金白银调用 LLM，未授权者不应能开这样的局。
 * 开发/测试默认 `open`，否则局域网开黑要先配口令。
 */
function defaultPolicy(): RoomCreatePolicy {
  return process.env.NODE_ENV === "production" ? "admin" : "open";
}

export function roomCreatePolicy(): RoomCreatePolicy {
  const raw = (process.env.ROOM_CREATE_POLICY ?? "").trim().toLowerCase();
  if (raw === "open" || raw === "admin" || raw === "invite") return raw;
  const fallback = defaultPolicy();
  if (raw) console.warn(`[room-policy] ROOM_CREATE_POLICY 取值无法识别，按 ${fallback} 处理`);
  return fallback;
}

/** 只有 AI 座位会产生 LLM 费用，纯真人房不受策略约束。 */
function hasAiSeat(seats: { kind: string }[]): boolean {
  return seats.some((s) => s.kind === "ai");
}

/**
 * 创建/改座位时的 AI 座位授权检查。返回 null 表示放行，否则为应直接回给客户端的响应。
 *
 * `invite` 模式下未配置 `ROOM_INVITE_CODE` 一律拒绝（fail closed）：
 * 配错环境变量不该等于「谁都能开」，那正是本策略要挡住的场景。
 */
export function requireRoomCreateAuth(
  req: Request,
  seats: { kind: string }[],
  inviteCode?: unknown
): NextResponse | null {
  if (!hasAiSeat(seats)) return null;
  const policy = roomCreatePolicy();

  if (policy === "open") return null;
  if (policy === "admin") {
    try {
      return isAdminRequest(req)
        ? null
        : NextResponse.json({ error: "创建含 AI 座位的房间需要管理员身份" }, { status: 403 });
    } catch {
      // 生产环境漏配 ADMIN_TOKEN（或与主密钥相同）时 assertAdminConfig 会抛错。
      // 建房的拒绝原因不该以 500 的形式砸到玩家脸上，按 fail closed 给可读文案。
      console.warn("[room-policy] 管理面未正确配置，含 AI 座位的房间已拒绝创建");
      return NextResponse.json({ error: "服务未正确配置管理员口令，暂时无法创建含 AI 座位的房间" }, { status: 403 });
    }
  }

  const expected = (process.env.ROOM_INVITE_CODE ?? "").trim();
  if (!expected) {
    console.warn("[room-policy] ROOM_CREATE_POLICY=invite 但未配置 ROOM_INVITE_CODE，含 AI 座位的房间已拒绝创建");
    return NextResponse.json({ error: "服务未配置邀请码，暂时无法创建含 AI 座位的房间" }, { status: 403 });
  }
  return typeof inviteCode === "string" && inviteCode && safeEqualString(inviteCode, expected)
    ? null
    : NextResponse.json({ error: "邀请码不正确" }, { status: 403 });
}
