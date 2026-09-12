/**
 * 时间线标题的卫生判定。
 *
 * 历史成因：早期生成/录入管线把「连续叙述」机械切成逐条事件，标题一律写成「事件 N」。
 * 这类占位标题不含任何信息，却会一路流进 AI 玩家的 system prompt（`compat.timelineToText`）、
 * 角色面板（`TimelineList`）与 DM 复盘宣读（`compat.fullTimelineText`），
 * 模型有相当概率把它当成事件名照念。渲染层与校验器共用这里的判定，避免两处漂移。
 */

const PLACEHOLDER_TITLE = /^事件\s*\d+$/;

/** 标题是否为机械占位（「事件 1」「事件 12」…）。 */
export function isPlaceholderTimelineTitle(title: string | null | undefined): boolean {
  return PLACEHOLDER_TITLE.test(String(title ?? "").trim());
}

/** 首个字符是收尾类符号 → 该条明显是上一句被切断后剩下的尾巴。 */
const TRUNCATED_HEAD = /^[）)」』】\]）]|^\)[^）]/;
/** 末字符是开括号/连接符 → 该条明显是下一句被截走的开头。 */
const TRUNCATED_TAIL = /[（(【「→—]$/;
/** 末字符是句中停顿/悬空成分 → 早期管线按逗号劈句留下的半句。 */
const TRUNCATED_TAIL_SOFT = /[，,、：:]$/;

/**
 * 条目正文是否明显被机械切断（首尾缺一半）。
 * 含「逗号结尾」形态：时间线条目应是自足的一句，以句中停顿收尾说明后半句被切走。
 * 这种缺失无法在渲染层还原，只能提示作者重写——校验器据此报 warning。
 */
export function isTruncatedTimelineText(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return TRUNCATED_HEAD.test(t) || TRUNCATED_TAIL.test(t) || TRUNCATED_TAIL_SOFT.test(t);
}

const LEADING_TIME = /^\d{1,2}:\d{2}(?::\d{2})?\s*/;
/** 开头的成对括号（如「（悄悄）」）：括号里是旁注，不该当标题 */
const LEADING_PAREN = /^[（(【「][^）)】」]{0,12}[）)】」]\s*/;
const LEADING_PUNCT = /^[）)】」"'“”\s、，。；：→—…·]+/;
const TRAILING_PUNCT = /[）)】」"'“”，,、。；：\s]+$/;

/**
 * 从正文里抽一个可读标题（数据批次用）：取第一句的第一个短句，去掉时刻/旁注/引导符号后截断。
 * 只从条目自身的正文取材，不引入任何新事实。
 */
export function deriveTimelineTitle(text: string, maxLength = 20): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  // 砍在第一个开括号之前：正文被截断时留下的未闭合括号不该进标题
  const cutAtBracket = (s: string) => {
    const open = s.search(/[（(【「]/);
    return open > 0 ? s.slice(0, open) : s;
  };
  let title = cutAtBracket(flat.split(/[。；！？\n]/)[0].split(/[，,]/)[0]);
  title = cutAtBracket(title.replace(LEADING_PAREN, ""))
    .replace(LEADING_TIME, "")
    .replace(LEADING_PUNCT, "")
    .replace(TRAILING_PUNCT, "")
    .trim();
  if (!title) title = flat.slice(0, maxLength);
  return title.length > maxLength ? `${title.slice(0, maxLength)}…` : title;
}
