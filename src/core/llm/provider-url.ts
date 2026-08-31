/**
 * 把聊天接口路径收成 API 根地址。只按协议剥标准操作段，不按厂商写死域名。
 */
export function normalizeProviderBaseUrl(baseUrl: string, protocol = "openai_compatible"): string {
  const u = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "anthropic") {
    return u.replace(/\/v1\/messages$/i, "").replace(/\/messages$/i, "");
  }
  return u.replace(/\/chat\/completions$/i, "").replace(/\/completions$/i, "");
}

/** 沿路径向上生成可能的 /models 探测地址（同源，不写死厂商）。 */
export function candidateModelListUrls(baseUrl: string): string[] {
  let href = baseUrl.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  const u = new URL(href);
  const segs = u.pathname.split("/").filter(Boolean);
  const bases: string[] = [];
  for (let i = segs.length; i >= 0; i--) {
    const path = i === 0 ? "" : `/${segs.slice(0, i).join("/")}`;
    bases.push(`${u.origin}${path}`);
  }
  const urls: string[] = [];
  for (const b of bases) {
    urls.push(`${b}/models`);
    urls.push(`${b}/v1/models`);
  }
  return [...new Set(urls)];
}
