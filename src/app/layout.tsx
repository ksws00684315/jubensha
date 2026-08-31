import type { Metadata } from "next";
import Link from "next/link";
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
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur sticky top-0 z-40">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-4">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-wide">
              <span className="text-xl">🎭</span>
              <span>剧本杀 <span className="text-zinc-500 font-normal">· AI 演绎</span></span>
            </Link>
            <nav className="flex gap-5 text-sm text-zinc-400">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="hover:text-zinc-100 transition-colors">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
