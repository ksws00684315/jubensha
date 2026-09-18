import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

/** 一次性为迁移前的进行中/已结束对局固定当前规范化剧本。不会覆盖已有快照。 */
const db = new PrismaClient();
const write = process.argv.includes("--write");

async function main() {
  const games = await db.game.findMany({ where: { scriptSnapshot: { equals: Prisma.DbNull } } });
  let changed = 0;
  for (const game of games) {
    const script = await db.script.findUnique({ where: { id: game.scriptId }, select: { content: true } });
    if (!script) {
      console.error(`跳过 ${game.id}：剧本不存在`);
      continue;
    }
    const snapshot = script.content;
    if (snapshot === null) continue;
    const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (write) {
      await db.game.update({
        where: { id: game.id },
        data: { scriptSnapshot: snapshot as Prisma.InputJsonValue, scriptHash: hash, scriptSnapshotSource: "legacy_baseline" },
      });
    }
    changed++;
    console.log(`${write ? "固定" : "将固定"} ${game.id} ${hash.slice(0, 12)}`);
  }
  console.log(`${write ? "已" : "将"}处理 ${changed} 局${write ? "" : "（dry-run，加 --write 才回写）"}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
