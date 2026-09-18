"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/", label: "首页" },
  { href: "/scripts", label: "剧本库" },
  { href: "/rooms/new", label: "开房间" },
  { href: "/settings", label: "设置" },
];

/** 顶部导航。aria-current 需要当前路径，故独立成客户端组件（layout 保持服务端）。 */
export function TopNav() {
  const pathname = usePathname();
  return (
    <nav className="mt-3 grid grid-cols-4 border-t border-gold-400/10 pt-2 text-center text-sm text-paper-400 sm:mt-0 sm:flex sm:gap-5 sm:border-0 sm:pt-0 sm:text-left">
      {nav.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap py-1 transition-colors hover:text-paper-50 sm:py-0 ${active ? "text-paper-50" : ""}`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
