/** 从 LLM 输出中稳健地提取 JSON 对象（容忍 markdown 代码块、前后缀文本） */
export function extractJson<T = unknown>(text: string): T | null {
  const trimmed = text.trim();
  // 1) 直接解析
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* continue */
  }
  // 2) 剥离 ```json ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      /* continue */
    }
  }
  // 3) 找第一段平衡的花括号
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}
