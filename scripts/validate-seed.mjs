#!/usr/bin/env node
/**
 * 剧本种子校验器（零依赖，供生成/导入前快速检查）。
 * 用法: node scripts/validate-seed.mjs <file.json> [more.json ...]
 * 通过标准: 0 error；warning 尽量为 0。
 */
import { readFileSync } from "node:fs";

const DIFFICULTIES = new Set(["新手", "进阶", "硬核"]);
const POLICIES = new Set(["auto_public", "manual_public", "keep_private"]);
const ASCII_ALLOW = new Set(["AI", "K97", "Nature", "UT"]);
const ID_RE = /^[a-z0-9_]+$/;

function validate(doc, file) {
  const errors = [];
  const warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (doc?.version !== 1) E("version 必须为 1");
  const meta = doc?.meta ?? {};
  for (const k of ["title", "intro", "difficulty"]) if (!meta[k]) E(`meta.${k} 缺失`);
  if (!DIFFICULTIES.has(meta.difficulty)) E(`meta.difficulty 非法: ${meta.difficulty}`);
  if (!Number.isInteger(meta.minPlayers) || !Number.isInteger(meta.maxPlayers)) E("meta.minPlayers/maxPlayers 必须是整数");
  if (meta.minPlayers > meta.maxPlayers) E("minPlayers > maxPlayers");
  if (typeof doc?.background !== "string" || doc.background.length < 40) E("background 缺失或过短");

  const chars = doc?.characters ?? [];
  if (chars.length < 3) E("characters 少于 3");
  const charIds = chars.map((c) => c.id);
  if (charIds.some((id) => !ID_RE.test(id))) E("存在非法角色 id（须 ^[a-z0-9_]+$）");
  if (new Set(charIds).size !== charIds.length) E("角色 id 重复");
  if (chars.length < meta.minPlayers || chars.length > meta.maxPlayers) E(`角色数 ${chars.length} 不在 ${meta.minPlayers}-${meta.maxPlayers}`);
  const culprits = chars.filter((c) => c?.card?.isCulprit);
  if (culprits.length !== 1) E(`isCulprit 标记了 ${culprits.length} 人（必须恰好 1）`);

  for (const c of chars) {
    for (const k of ["name", "publicBio"]) if (!c[k]) E(`角色 ${c.id || "?"} 缺 ${k}`);
    const card = c.card ?? {};
    for (const k of ["backstory", "secret", "goal", "timeline", "persona"]) if (!card[k] || String(card[k]).length < 10) E(`角色 ${c.id || "?"} 的 card.${k} 缺失或过短`);
    if (!Array.isArray(card.knowledge)) W(`角色 ${c.id || "?"} 的 knowledge 不是数组`);
  }
  const culprit = culprits[0];
  if (doc?.truth?.culprit !== culprit?.id) E(`truth.culprit(${doc?.truth?.culprit}) 与 isCulprit 角色(${culprit?.id}) 不一致`);

  const locations = doc?.locations ?? [];
  if (locations.length < 2) E("locations 少于 2");
  if (new Set(locations).size !== locations.length) W("locations 有重复");

  const clues = doc?.clues ?? [];
  if (clues.length < 3) E("clues 少于 3");
  const clueIds = clues.map((c) => c.id);
  if (clueIds.some((id) => !ID_RE.test(id))) E("存在非法线索 id");
  if (new Set(clueIds).size !== clueIds.length) E("线索 id 重复");
  const autoPublic = clues.filter((c) => c.policy === "auto_public").length;
  if (autoPublic < 1) E("至少需要 1 张 auto_public 线索（死因）");
  if (autoPublic > Math.floor(clues.length / 3)) W(`auto_public 占比过高 (${autoPublic}/${clues.length})`);
  for (const c of clues) {
    if (!c.name || !c.content) E(`线索 ${c.id || "?"} 缺 name/content`);
    if (!POLICIES.has(c.policy)) E(`线索 ${c.id || "?"} policy 非法: ${c.policy}`);
    if (!locations.includes(c.location)) E(`线索「${c.name}」地点 ${c.location} 不在 locations`);
  }

  const truth = doc?.truth ?? {};
  for (const k of ["method", "fullTimeline", "reveal"]) if (!truth[k] || String(truth[k]).length < 20) E(`truth.${k} 缺失或过短`);
  const hay = clues.map((c) => `${c.name ?? ""}${c.content ?? ""}`).join("|");
  for (const key of truth.keyEvidence ?? []) {
    if (![hay, truth.fullTimeline ?? ""].some((h) => h.includes(key))) E(`keyEvidence「${key}」未在任何线索/时间线中逐字出现`);
  }

  // 中英混杂检查（仅警告）：正文里的长英文串
  const proseFields = [];
  proseFields.push(doc.background, truth.method, truth.fullTimeline, truth.reveal, meta.intro);
  for (const c of chars) proseFields.push(c.publicBio, c.card?.backstory, c.card?.secret, c.card?.goal, c.card?.timeline, c.card?.persona, ...(c.card?.knowledge ?? []));
  for (const c of clues) proseFields.push(c.content);
  const seen = new Set();
  for (const s of proseFields) {
    if (typeof s !== "string") continue;
    for (const m of s.matchAll(/[A-Za-z][A-Za-z-]{3,}/g)) {
      const w = m[0];
      if (ASCII_ALLOW.has(w) || seen.has(w)) continue;
      // 账号名等代码性文本（前后出现"账号"/"ID"）不算残留
      const ctx = s.slice(Math.max(0, m.index - 6), m.index + w.length + 4);
      if (/账号|ID/.test(ctx)) continue;
      seen.add(w);
      W(`正文出现英文「${w}」，请确认是否为残留`);
    }
  }

  return { file, errors, warnings };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法: node scripts/validate-seed.mjs <file.json> [...]");
  process.exit(2);
}
let failed = 0;
for (const f of files) {
  let result;
  try {
    const doc = JSON.parse(readFileSync(f, "utf-8"));
    result = validate(doc, f);
  } catch (err) {
    result = { file: f, errors: [`JSON 解析失败: ${err.message}`], warnings: [] };
  }
  const icon = result.errors.length ? "✗" : result.warnings.length ? "△" : "✓";
  console.log(`${icon} ${result.file}  error=${result.errors.length} warning=${result.warnings.length}`);
  for (const e of result.errors) console.log(`   [error] ${e}`);
  for (const w of result.warnings) console.log(`   [warn] ${w}`);
  if (result.errors.length) failed++;
}
console.log(failed ? `\n${failed} 个文件未通过` : "\n全部通过");
process.exit(failed ? 1 : 0);
