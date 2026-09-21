import { spawnSync } from "node:child_process";
import { resolveDatabaseUrl } from "../src/lib/app-config";
const url = resolveDatabaseUrl().url;
if (!url) throw new Error("数据库未配置");
const args = process.argv.includes("--deploy") ? ["prisma", "migrate", "deploy"] : ["prisma", "migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma", "--to-schema-datamodel", "prisma/schema.prisma", "--script"];
const result = spawnSync("npx", args, { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
process.exit(result.status ?? 1);
