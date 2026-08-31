import { PrismaClient } from "@prisma/client";
import { ingestScriptDoc } from "../src/core/script/compat";
import { validateScriptV2 } from "../src/core/script/v2/validate";

const write = process.argv.includes("--write");
const db = new PrismaClient();

async function main() {
  const rows = await db.script.findMany({ where: { deleted: false }, select: { id: true, title: true, content: true } });
  let already = 0;
  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    const version = (row.content as { version?: unknown } | null)?.version;
    if (version === 2) {
      already++;
      continue;
    }
    try {
      const ingested = ingestScriptDoc(row.content);
      const errors = validateScriptV2(ingested.doc).filter((issue) => issue.level === "error");
      if (errors.length) {
        failed++;
        console.error(`✗ ${row.id} ${row.title}: ${errors.map((issue) => issue.message).join("; ")}`);
        continue;
      }
      if (write) {
        await db.script.update({
          where: { id: row.id },
          data: {
            title: ingested.doc.meta.title,
            minPlayers: ingested.doc.meta.minPlayers,
            maxPlayers: ingested.doc.meta.maxPlayers,
            durationMin: ingested.doc.meta.durationMin,
            difficulty: ingested.doc.meta.difficulty,
            tags: ingested.doc.meta.tags,
            intro: ingested.doc.meta.intro,
            content: ingested.doc as unknown as object,
          },
        });
      }
      migrated++;
      console.log(`${write ? "已写入" : "将迁移"} ${row.id} ${row.title}（${ingested.migrationWarnings.length} 条警告）`);
    } catch (error) {
      failed++;
      console.error(`✗ ${row.id} ${row.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`合计 ${rows.length}：已是 V2 ${already}，待/已迁移 ${migrated}，失败 ${failed}${write ? "" : "（dry-run，加 --write 才回写）"}`);
  if (failed) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
