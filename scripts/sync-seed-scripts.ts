import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { ingestScriptDoc } from "../src/core/script/compat";
import { validateScriptV2 } from "../src/core/script/v2/validate";
import { resolveDatabaseUrl } from "../src/lib/app-config";
import { DEMO_SCRIPT_FILES, FORMAL_SCRIPT_FILES } from "./formal-script-manifest";

const fileArg = process.argv.find((arg) => arg.startsWith("--file="))?.slice(7);
const expectedHash = process.argv.find((arg) => arg.startsWith("--expected-hash="))?.slice(16);
const write = process.argv.includes("--write");
const includeDemos = process.argv.includes("--include-demos");
const database = resolveDatabaseUrl();
if (!database.url) throw new Error("未配置数据库，请先在设置页选择数据库");
const db = new PrismaClient({ datasources: { db: { url: database.url } } });

function seedFiles(): string[] {
  const files = [...FORMAL_SCRIPT_FILES, ...(includeDemos ? DEMO_SCRIPT_FILES : [])]
    .filter((file) => !fileArg || file === fileArg)
    .map((file) => path.resolve(process.cwd(), file));
  if (fileArg && !files.length) throw new Error("指定文件不在正式剧本清单内");
  if (write && fileArg && !expectedHash) throw new Error("单本写入必须提供 dry-run 的 --expected-hash");
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length) throw new Error(`正式剧本清单存在缺失文件：${missing.join("、")}`);
  return files;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function main() {
  console.log(`同步范围：${includeDemos ? `${FORMAL_SCRIPT_FILES.length} 本正式剧本 + 演示样本` : `${FORMAL_SCRIPT_FILES.length} 本正式剧本（演示样本已排除）`}`);
  const rows = await db.script.findMany({ where: { deleted: false }, select: { id: true, title: true, content: true } });
  const byTitle = new Map<string, string[]>();
  for (const row of rows) {
    const list = byTitle.get(row.title) ?? [];
    list.push(row.id);
    byTitle.set(row.title, list);
  }

  let updated = 0;
  let created = 0;
  let failed = 0;
  let warned = 0;
  const seen = new Set<string>();
  const expectedHashes = new Map<string, string>();

  for (const file of seedFiles()) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    try {
      const ingested = ingestScriptDoc(raw);
      const issues = validateScriptV2(ingested.doc);
      // error 阻断同步；warning 属内容审查债务，逐条打印但不拦截——
      // 存量剧本的 warning 清零前，若一并阻断会让这些剧本从此无法同步。
      const errors = issues.filter((issue) => issue.level === "error" || issue.message.startsWith("没有有效私藏窗口"));
      if (errors.length) {
        failed++;
        console.error(`✗ ${file}: ${errors.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
        continue;
      }
      for (const warning of issues) {
        console.warn(`⚠ ${file}: ${warning.path} ${warning.message}`);
        warned++;
      }
      const doc = ingested.doc;
      const hash = contentHash(doc);
      console.log(`内容 hash ${ingested.doc.meta.title}: ${hash}`);
      if (expectedHash && hash !== expectedHash) throw new Error("内容 hash 与 dry-run 不一致，拒绝同步");
      const title = doc.meta.title;
      if (seen.has(title)) {
        console.error(`✗ 种子标题重复：${title} (${file})`);
        failed++;
        continue;
      }
      seen.add(title);
      const ids = byTitle.get(title) ?? [];
      for (const id of ids) console.log(`现存 hash ${id}: ${contentHash(rows.find((row) => row.id === id)?.content)}`);
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
        for (const id of ids) {
          await db.script.update({ where: { id }, data });
          expectedHashes.set(id, contentHash(doc));
        }
        console.log(`已更新 ${title} ×${ids.length}`);
        updated += ids.length;
      } else {
        const createdRow = await db.script.create({ data });
        expectedHashes.set(createdRow.id, contentHash(doc));
        console.log(`已新建 ${title} -> ${createdRow.id}`);
        created++;
      }
    } catch (error) {
      failed++;
      console.error(`✗ ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (write && expectedHashes.size) {
    const savedRows = await db.script.findMany({ where: { id: { in: [...expectedHashes.keys()] } }, select: { id: true, content: true } });
    const savedById = new Map(savedRows.map((row) => [row.id, row.content]));
    let hashFailures = 0;
    for (const [id, expected] of expectedHashes) {
      const actual = savedById.has(id) ? contentHash(savedById.get(id)) : "missing";
      if (actual !== expected) {
        hashFailures++;
        console.error(`✗ 内容 hash 校验失败：${id}`);
      }
    }
    failed += hashFailures;
    console.log(`内容 hash 校验：${expectedHashes.size - hashFailures} 条成功，${hashFailures} 条失败`);
  }

  console.log(`合计：更新 ${updated}，新建 ${created}，失败 ${failed}，警告 ${warned}${write ? "" : "（dry-run，加 --write 才回写）"}`);
  if (failed) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
