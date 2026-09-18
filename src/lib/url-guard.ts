import dns from "node:dns/promises";
import net from "node:net";

/**
 * LLM baseUrl 的 SSRF 守卫。
 *
 * 管理面本身可配置任意 provider 与数据库地址，SSRF 守卫的价值在于纵深防御：
 * 云元数据/链路本地段（169.254.0.0/16、fe80::、*.internal）无条件封禁；
 * 回环与 RFC1918 会误伤 Ollama/LM Studio 等本地推理，默认放行，
 * 需要收紧时设 ALLOW_PRIVATE_PROVIDER_URL=0（独立审查 M9）。
 */

function normalizeIp(ip: string): string {
  const v = ip.replace(/^\[|\]$/g, "").toLowerCase();
  return v.match(/^::ffff:(.+)$/)?.[1] ?? v;
}

export function isPrivateIp(ip: string): boolean {
  const mapped = normalizeIp(ip);
  if (net.isIPv4(mapped)) {
    const [a, b] = mapped.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (net.isIPv6(mapped)) {
    return mapped === "::1" || mapped.startsWith("fe80") || mapped.startsWith("fc") || mapped.startsWith("fd");
  }
  return false;
}

/** 云元数据/链路本地：任何配置下都不可达（回环不在此列——本地推理依赖它，默认放行） */
function isMetadataOrLinkLocal(ip: string): boolean {
  const mapped = normalizeIp(ip);
  if (net.isIPv4(mapped)) {
    const [a, b] = mapped.split(".").map(Number);
    return (a === 169 && b === 254) || a === 0;
  }
  if (net.isIPv6(mapped)) return mapped.startsWith("fe80");
  return false;
}

function blockPrivate(): boolean {
  return process.env.ALLOW_PRIVATE_PROVIDER_URL === "0";
}

/** 校验 baseUrl 是否允许访问；违规抛错。 */
export async function assertProviderUrlAllowed(raw: string): Promise<void> {
  let href = raw?.trim() ?? "";
  if (!href) throw new Error("baseUrl 不能为空");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) && !/^https?:\/\//i.test(href)) {
    throw new Error("仅支持 http/https 协议");
  }
  if (!/^https?:\/\//i.test(href)) href = `http://${href}`;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    throw new Error("baseUrl 不是合法的 http/https 地址");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅支持 http/https 协议");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error("baseUrl 缺少主机名");
  if (host.endsWith(".internal") || host === "metadata" || host.endsWith(".metadata")) {
    throw new Error("目标地址指向元数据/内部域名，已按 SSRF 策略封禁");
  }
  const deny = (why: string) => {
    throw new Error(why);
  };
  if (net.isIP(host)) {
    if (isMetadataOrLinkLocal(host)) deny("目标地址指向链路本地/回环/元数据段，已按 SSRF 策略封禁");
    if (blockPrivate() && isPrivateIp(host)) deny("目标地址指向私网/回环段，且 ALLOW_PRIVATE_PROVIDER_URL=0");
    return;
  }
  if (blockPrivate() && (host === "localhost" || host.endsWith(".localhost"))) {
    deny("本机地址已被 ALLOW_PRIVATE_PROVIDER_URL=0 封禁");
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (isMetadataOrLinkLocal(a.address)) deny("域名解析到链路本地/回环/元数据地址，已按 SSRF 策略封禁");
      if (blockPrivate() && isPrivateIp(a.address)) deny("域名解析到私网地址，且 ALLOW_PRIVATE_PROVIDER_URL=0");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("SSRF")) throw err;
    // DNS 解析失败本身不拦截，交给后续 fetch 报连接错误
  }
}
