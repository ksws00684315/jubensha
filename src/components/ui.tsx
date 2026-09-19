"use client";

import { useEffect, useId, useRef } from "react";
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

/** 破坏性操作确认弹窗：role=dialog + Esc + Tab 焦点圈定，关闭后焦点归还触发元素（替代原生 confirm()）。 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "确认删除",
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 键盘监听仅挂载时订阅一次（避免重渲染焦点复位），处理器经 ref 取最新值
  const latest = useRef({ busy, onCancel });
  useEffect(() => {
    latest.current = { busy, onCancel };
  }, [busy, onCancel]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    el?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !latest.current.busy) {
        latest.current.onCancel();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const focusables = el.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => !busy && onCancel()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl border border-gold-400/20 bg-ink-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="font-semibold text-paper-50">
          {title}
        </h3>
        {description && <p className="mt-2 text-sm text-paper-300">{description}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
