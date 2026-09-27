import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-center justify-center text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-3 text-3xl font-semibold text-paper-50">这页暂时找不到</h1>
      <p className="mt-3 text-paper-300">链接可能已失效，或页面已经移走。</p>
      <Link href="/" className="mt-6 rounded-lg border border-gold-400/30 px-4 py-2 text-gold-300 hover:bg-gold-400/10">
        返回首页
      </Link>
    </section>
  );
}
