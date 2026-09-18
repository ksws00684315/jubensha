"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/**
 * 墨金设计 token 下的共享控件。各页面（批次 H）逐页从 zinc/amber 硬编码色迁移到这里，
 * 迁移完成前允许旧页面并存；新代码一律使用本文件组件。
 */

const VARIANTS = {
  gold: "bg-gold-400 text-ink-950 hover:bg-gold-300 disabled:hover:bg-gold-400",
  ghost: "border border-gold-400/30 text-gold-300 hover:bg-gold-400/10",
  danger: "border border-danger-400/40 text-danger-400 hover:bg-danger-400/10",
  secret: "border border-secret-400/40 text-secret-400 hover:bg-secret-400/10",
} as const;

export function Button({
  variant = "gold",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

const FIELD =
  "w-full rounded-lg border border-gold-400/20 bg-ink-950/60 px-3 py-2 text-sm text-paper-100 placeholder:text-paper-500 focus:border-gold-400/60 focus:outline-none focus:ring-1 focus:ring-gold-400/40";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} ${className}`} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD} ${className}`} />;
}

export function Card({
  title,
  actions,
  className = "",
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`game-panel p-4 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title ? <h3 className="text-sm font-medium text-gold-400">{title}</h3> : <span />}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
