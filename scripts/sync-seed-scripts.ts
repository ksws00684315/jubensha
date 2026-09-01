import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { ingestScriptDoc } from "../src/core/script/compat";
import { validateScriptV2 } from "../src/core/script/v2/validate";

const write = process.argv.includes("--write");
const db = new PrismaClient();

function seedFiles(): string[] {
  const roots = [path.join(process.cwd(), "seeds"), path.join(process.cwd(), "seeds/generated")];
  return roots.flatMap((root) =>
    readdirSync(root)
      .filter((file) => file.endsWith(".json"))
      .map((file) => path.join(root, file)),
  );
}

async function main() {
  const rows = await db.script.findMany({ where: { deleted: false }, select: { id: true, title: true } });
  const byTitle = new Map<string, string[]>();
  for (const row of rows) {
    const list = byTitle.get(row.title) ?? [];
    list.push(row.id);
    byTitle.set(row.title, list);
  }

  let updated = 0;
  let created = 0;
  let failed = 0;
  const seen = new Set<string>();

  for (const file of seedFiles()) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    try {
      const ingested = ingestScriptDoc(raw);
      const errors = validateScriptV2(ingested.doc).filter((issue) => issue.level === "error");
      if (errors.length) {
        failed++;
        console.error(`✗ ${file}: ${errors.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
        continue;
      }
      const doc = ingested.doc;
      const title = doc.meta.title;
      if (seen.has(title)) {
        console.error(`✗ 种子标题重复：${title} (${file})`);
        failed++;
        continue;
      }
      seen.add(title);
      const ids = byTitle.get(title) ?? [];
      const data = {
        title: doc.meta.title,
        minPlayers: doc.meta.minPlayers,
        maxPlayers: doc.meta.maxPlayers,
        durationMin: doc.meta.durationMin,
        difficulty: doc.meta.difficulty,
        tags: doc.meta.tags,
        intro: doc.meta.intro,
        content: doc as unknown as object,
        source: "import" as const,
      };
      if (!write) {
        console.log(`${ids.length ? "将更新" : "将新建"} ${title} (${file})${ids.length > 1 ? ` 匹配 ${ids.length} 条` : ""}`);
        if (ids.length) updated++;
        else created++;
        continue;
      }
      if (ids.length) {
        for (const id of ids) await db.script.update({ where: { id }, data });
        console.log(`已更新 ${title} ×${ids.length}`);
        updated += ids.length;
      } else {
        const createdRow = await db.script.create({ data });
        console.log(`已新建 ${title} -> ${createdRow.id}`);
        created++;
      }
    } catch (error) {
      failed++;
      console.error(`✗ ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`合计：更新 ${updated}，新建 ${created}，失败 ${failed}${write ? "" : "（dry-run，加 --write 才回写）"}`);
  if (failed) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
