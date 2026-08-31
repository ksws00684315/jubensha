import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/VisualIcons";
import "./globals.css";

export const metadata: Metadata = {
  title: "剧本杀 · AI 演绎",
  description: "AI 剧本杀网页游戏：真人玩家 + AI 玩家混合对局",
};

const nav = [
  { href: "/", label: "首页" },
  { href: "/scripts", label: "剧本库" },
  { href: "/rooms/new", label: "开房间" },
  { href: "/settings", label: "设置" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-ink-950 text-paper-50 antialiased">
        <header className="sticky top-0 z-40 border-b border-gold-400/10 bg-ink-950/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl flex-col px-4 py-3 sm:h-14 sm:flex-row sm:items-center sm:gap-8 sm:py-0">
            <Link href="/" className="flex items-center gap-2.5 whitespace-nowrap font-semibold tracking-wide">
              <BrandMark className="size-7 text-gold-400" />
              <span>剧本杀 <span className="font-normal text-paper-500">· AI 演绎</span></span>
            </Link>
            <nav className="mt-3 grid grid-cols-4 border-t border-gold-400/10 pt-2 text-center text-sm text-paper-400 sm:mt-0 sm:flex sm:gap-5 sm:border-0 sm:pt-0 sm:text-left">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="whitespace-nowrap py-1 transition-colors hover:text-paper-50 sm:py-0">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
