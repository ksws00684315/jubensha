import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import crypto from "node:crypto";
import { decideDmJoin } from "@/lib/join";

const schema = z.object({
  code: z.string().min(3),
  name: z.string().min(1).max(20),
});

/** 真人 DM 加入：认领房间的 DM 身份；同名可换设备认领回。 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "参数不合法" }, { status: 400 });

  const room = await db.room.findUnique({
    where: { code: parsed.data.code.toUpperCase() },
    include: { game: true },
  });
  if (!room) return NextResponse.json({ error: "房间不存在" }, { status: 404 });
  const name = parsed.data.name.trim();
  const decision = decideDmJoin(room.humanDm, room.dmToken, room.dmName, name);
  if (decision === "not-human-dm") {
    return NextResponse.json({ error: "该房间未开启真人 DM 模式" }, { status: 400 });
  }

  const token = crypto.randomBytes(16).toString("hex");
  if (decision === "resume") {
    await db.room.update({ where: { id: room.id }, data: { dmToken: token } });
    return NextResponse.json({ roomId: room.id, token, gameId: room.game?.id ?? null, resumed: true });
  }
  if (decision === "taken") {
    return NextResponse.json({ error: "本房间的 DM 已有人担任。若是你本人，请填写认领时用的昵称。" }, { status: 400 });
  }

  const claimed = await db.room.updateMany({
    where: { id: room.id, dmToken: null, humanDm: true },
    data: { dmToken: token, dmName: name },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "本房间的 DM 已有人担任。若是你本人，请填写认领时用的昵称。" }, { status: 400 });
  }
  return NextResponse.json({ roomId: room.id, token, gameId: room.game?.id ?? null, resumed: false });
}
