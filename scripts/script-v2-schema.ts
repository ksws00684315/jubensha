import { mkdirSync, writeFileSync } from "node:fs";
import { scriptDocV2Schema } from "../src/core/script/v2/schema";
import { toJSONSchema } from "zod";

const output = "schemas/script-input-v2.schema.json";
mkdirSync("schemas", { recursive: true });
writeFileSync(output, `${JSON.stringify(toJSONSchema(scriptDocV2Schema), null, 2)}\n`, "utf8");
console.log(`已生成 ${output}`);
