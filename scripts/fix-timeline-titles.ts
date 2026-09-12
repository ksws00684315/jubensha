/**
 * 数据批次：把种子剧本时间线里的机械占位标题（「事件 1」「事件 2」…）改为内容摘要。
 *
 * 背景（独立审查 S2）：早期生成/录入管线把连续叙述机械切成逐条事件，标题一律写成「事件 N」。
 * 全库 34 本共 1422 条（角色时间线 930 + 真相时间线 492）——它会被原样送进
 * AI 玩家的 system prompt 与 DM 的复盘宣读，模型会把它当事件名念出来。
 *
 * 本脚本只做一件事：标题取该条目自身正文的首个短句（不引入任何新事实），
 * 正文被截断的条目保持原样（那是内容问题，需人工重写，由校验器 warning 标出）。
 *
 * 用法：
 *   npx tsx scripts/fix-timeline-titles.ts            # 只报告，不写盘
 *   npx tsx scripts/fix-timeline-titles.ts --write    # 写入
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deriveTimelineTitle, isPlaceholderTimelineTitle } from "../src/core/script/v2/timeline";

const WRITE = process.argv.includes("--write");
const files = [
  ...readdirSync("seeds").filter((f) => f.endsWith(".json")).map((f) => path.join("seeds", f)),
  ...readdirSync("seeds/generated").filter((f) => f.endsWith(".json")).map((f) => path.join("seeds/generated", f)),
];

type Block = { text?: string; items?: string[] };
const flatten = (blocks: Block[] | undefined): string =>
  (blocks ?? []).map((b) => b.text ?? (b.items ?? []).join(" ")).join(" ");

type Entry = { title?: string; content?: Block[] };

let touchedFiles = 0;
let touchedEntries = 0;
const samples: string[] = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.log(`跳过（JSON 解析失败）: ${file}`);
    continue;
  }
  if (doc.version !== 2) continue;

  let changed = 0;
  const fix = (entry: Entry) => {
    if (!isPlaceholderTimelineTitle(entry.title)) return;
    const derived = deriveTimelineTitle(flatten(entry.content));
    if (!derived) return; // 正文为空：保持原样，交校验器报出
    if (samples.length < 12) samples.push(`  ${file}  「${String(entry.title).trim()}」→「${derived}」`);
    entry.title = derived;
    changed++;
  };

  const characters = (doc.characters ?? []) as Array<{ privateCard?: { timeline?: Entry[] } }>;
  for (const character of characters) for (const entry of character.privateCard?.timeline ?? []) fix(entry);
  const truth = doc.truth as { timeline?: Entry[] } | undefined;
  for (const entry of truth?.timeline ?? []) fix(entry);

  if (!changed) continue;
  touchedFiles++;
  touchedEntries += changed;
  // 全部 34 本都能用 indent=2 字节级往返（已验证），因此写回只会产生标题行的 diff
  const next = JSON.stringify(doc, null, 2);
  if (WRITE) writeFileSync(file, next, "utf8");
  console.log(`${WRITE ? "已改" : "待改"} ${file}: ${changed} 条`);
}

console.log(`\n${WRITE ? "已写入" : "预览"}：${touchedFiles} 个文件 / ${touchedEntries} 条占位标题`);
if (samples.length) console.log(`样例：\n${samples.join("\n")}`);
if (!WRITE && touchedEntries) console.log("\n加 --write 才会写盘。");
