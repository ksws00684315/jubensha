import Link from "next/link";
import JoinBox from "@/components/JoinBox";
import ContinueGames from "@/components/ContinueGames";
import { BrandMark, FeatureIcon, type FeatureIconName } from "@/components/VisualIcons";

const features: Array<{ icon: FeatureIconName; index: string; title: string; desc: string }> = [
  {
    icon: "ensemble",
    index: "01",
    title: "AI 玩家补位",
    desc: "凑不齐人？每个座位都可以是 AI：AI 会读本、搜证、圆桌对线、隐藏自己的秘密，凶手 AI 由强模型扮演。",
  },
  {
    icon: "firewall",
    index: "02",
    title: "信息防火墙",
    desc: "AI 玩家只看得到公开事件流和自己的角色卡，全局真相只有 DM 掌握；发言经泄露检测，防止 AI 剧透。",
  },
  {
    icon: "archive",
    index: "03",
    title: "剧本可管理、可生成",
    desc: "结构化剧本 Schema + 逻辑校验器，支持 JSON 导入导出；后续可用 AI 生成原创剧本直接入库。",
  },
];

export default function HomePage() {
  return (
    <div className="space-y-12 sm:space-y-20">
      <section className="home-hero grid items-center gap-10 pt-2 sm:pt-8 lg:grid-cols-[1.08fr_.92fr] lg:gap-16 lg:pt-12">
        <div className="text-center lg:text-left">
          <p className="eyebrow flex items-center justify-center gap-2 lg:justify-start">
            <span className="h-px w-8 bg-gold-400/60" />
            AI 沉浸式推理剧场
          </p>
          <h1 className="mt-5 text-[2.45rem] font-bold leading-[1.08] tracking-[-0.04em] text-paper-50 sm:text-6xl sm:leading-[1.05]">
            <span className="block">一场不用凑人的</span>
            <span className="mt-1 block whitespace-nowrap text-gold-400">剧本杀</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-sm leading-7 text-paper-400 sm:text-base lg:mx-0">
            真人玩家与 AI 玩家混合对局。读本、搜证、圆桌对峙、投票指凶，全流程由 AI 主持人控场。
            选一个剧本，开一间房，随时入戏。
          </p>
          <div className="mx-auto mt-7 grid max-w-sm grid-cols-2 gap-3 sm:mt-8 sm:flex sm:max-w-none lg:mx-0">
            <Link
              href="/rooms/new"
              className="whitespace-nowrap rounded-lg bg-gold-500 px-4 py-3 font-semibold text-ink-950 shadow-[0_10px_35px_rgba(217,154,50,.2)] transition hover:bg-gold-400 sm:px-6"
            >
              创建房间
            </Link>
            <Link
              href="/scripts"
              className="whitespace-nowrap rounded-lg border border-gold-400/20 bg-ink-900/60 px-4 py-3 font-medium text-paper-200 transition hover:border-gold-400/50 hover:text-paper-50 sm:px-6"
            >
              浏览剧本库
            </Link>
          </div>
          <div className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-paper-500 lg:justify-start">
            <span><b className="mr-1.5 text-paper-200">真人 + AI</b>自由混编</span>
            <span><b className="mr-1.5 text-paper-200">全流程</b>智能主持</span>
            <span><b className="mr-1.5 text-paper-200">私密信息</b>严格隔离</span>
          </div>
        </div>

        <div className="hero-emblem" aria-hidden="true">
          <span className="absolute left-10 top-10 hidden text-[10px] font-semibold tracking-[0.22em] text-gold-400/60 sm:block">CASE · OPEN</span>
          <span className="absolute right-7 top-7 size-2 rounded-full bg-danger-400 shadow-[0_0_16px_rgba(229,106,103,.75)]" />
          <div className="text-center">
            <div className="hero-emblem__seal">
              <BrandMark className="size-24 text-gold-400" />
            </div>
            <p className="mt-6 text-xs font-semibold tracking-[0.28em] text-paper-400">MYSTERY IN MOTION</p>
          </div>
          <span className="absolute bottom-9 left-10 hidden font-mono text-[10px] text-paper-500 sm:block">NO. 189-AI</span>
          <span className="absolute bottom-9 right-10 hidden text-[10px] tracking-widest text-paper-500 sm:block">等待入戏</span>
        </div>
      </section>

      <section className="grid items-center gap-7 lg:grid-cols-[.75fr_1.25fr] lg:gap-14">
        <div className="text-center lg:text-left">
          <p className="eyebrow">Room Access</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-paper-50 sm:text-3xl">已有案件正在进行？</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-7 text-paper-400 lg:mx-0">
            输入房间码和你的称呼，即刻加入案发现场。你的身份与秘密，只会向你揭晓。
          </p>
        </div>
        <div className="flex flex-col items-center gap-6 lg:items-end">
          <ContinueGames />
          <JoinBox />
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="feature-card p-6">
            <div className="flex items-start justify-between">
              <span className="grid size-11 place-items-center rounded-xl border border-gold-400/15 bg-gold-400/5 text-gold-400">
                <FeatureIcon name={f.icon} className="size-6" />
              </span>
              <span className="font-mono text-xs text-paper-500">{f.index}</span>
            </div>
            <h3 className="mt-5 font-semibold text-paper-50">{f.title}</h3>
            <p className="mt-2 text-sm leading-7 text-paper-400">{f.desc}</p>
          </div>
        ))}
      </section>

      <section className="surface-panel relative overflow-hidden p-6 text-sm text-paper-400 sm:p-8">
        <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-transparent via-gold-400 to-transparent" />
        <p className="eyebrow">Before The Curtain</p>
        <h3 className="mt-2 font-medium text-paper-50">开始之前</h3>
        <p className="mt-2 leading-7">
          首次使用请先到{" "}
          <Link href="/settings" className="text-gold-400 hover:underline">
            设置 → AI 接入
          </Link>{" "}
          配置至少一个模型 Provider，并为「DM 主持人」「凶手玩家」「普通 AI 玩家」绑定模型。没有可用模型时，AI 玩家将无法发言。
        </p>
      </section>
    </div>
  );
}
