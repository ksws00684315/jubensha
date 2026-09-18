import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/VisualIcons";
import { TopNav } from "@/components/TopNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "剧本杀 · AI 演绎",
  description: "AI 剧本杀网页游戏：真人玩家 + AI 玩家混合对局",
};

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
            <TopNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
      </body>
    </html>
  );
}
