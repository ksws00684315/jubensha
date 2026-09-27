import type { NextConfig } from "next";

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

const isDev = process.env.NODE_ENV !== "production";

/**
 * 生产强制（Content-Security-Policy），开发只 report-only —— Next dev 需要 'unsafe-eval'
 * （React 用它还原服务端错误栈），生产构建不需要，因此生产策略里没有它。
 * 开发用 report-only 是因为热更新走 ws/blob 且脚本形态与生产不同，强行拦截只会挡住开发本身。
 */
function cspHeaderValue(): { key: string; value: string } {
  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])].join(" ");
  const value = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'self'",
  ].join("; ");
  return { key: isDev ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", value };
}

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SECURITY_HEADERS, cspHeaderValue()],
      },
    ];
  },
};

export default nextConfig;
