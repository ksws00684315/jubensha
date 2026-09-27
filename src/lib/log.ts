type LogFields = Record<string, unknown>;
type LogLevel = "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const SECRET_FIELD = /token|ticket|apiKey|password|secret|cipher/i;
const SK_SECRET = /sk-[A-Za-z0-9_-]{17,}/g;
const KEY_VALUE_SECRET = /((?:token|ticket|api[-_]?key|password|secret|cipher)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi;
const URL_PASSWORD = /(\b(?:postgres(?:ql)?|https?):\/\/[^:/@\s]+:)[^@/\s]+@/gi;
const BEARER_SECRET = /\bBearer\s+[^\s,;]+/gi;

function sanitizeString(value: string): string {
  return value
    .replace(SK_SECRET, "[redacted]")
    .replace(KEY_VALUE_SECRET, "$1[redacted]")
    .replace(URL_PASSWORD, "$1[redacted]@")
    .replace(BEARER_SECRET, "Bearer [redacted]");
}

function sanitizeValue(value: unknown, key: string | undefined, seen: WeakSet<object>, depth: number): unknown {
  if (key && SECRET_FIELD.test(key)) return "[redacted]";
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: sanitizeString(value.name), message: sanitizeString(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if (depth >= 10) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, undefined, seen, depth + 1));
  const clean: LogFields = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    clean[childKey] = sanitizeValue(childValue, childKey, seen, depth + 1);
  }
  return clean;
}

function minimumLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  return configured === "warn" || configured === "error" ? configured : "info";
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel()]) return;
  const cleanFields = sanitizeValue(fields ?? {}, undefined, new WeakSet(), 0) as LogFields;
  const record = { ...cleanFields, ts: new Date().toISOString(), level, msg: sanitizeString(msg) };
  let line: string;
  if (process.env.NODE_ENV === "development" && process.env.LOG_FORMAT === "pretty") {
    const { ts, msg: cleanMsg, ...rest } = record;
    const details = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
    line = `${ts} ${level.toUpperCase()} ${cleanMsg}${details}\n`;
  } else {
    line = `${JSON.stringify(record)}\n`;
  }
  if (level === "error") console.error(line.trimEnd());
  else if (level === "warn") console.warn(line.trimEnd());
  else process.stdout.write(line);
}

export const log = {
  info(msg: string, fields?: LogFields): void {
    write("info", msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    write("warn", msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    write("error", msg, fields);
  },
};
