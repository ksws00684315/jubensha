import Link from "next/link";
import JoinBox from "@/components/JoinBox";
import ContinueGames from "@/components/ContinueGames";

const features = [
  {
    icon: "🤖",
    title: "AI 玩家补位",
    desc: "凑不齐人？每个座位都可以是 AI：AI 会读本、搜证、圆桌对线、隐藏自己的秘密，凶手 AI 由强模型扮演。",
  },
  {
    icon: "🛡️",
    title: "信息防火墙",
    desc: "AI 玩家只看得到公开事件流和自己的角色卡，全局真相只有 DM 掌握；发言经泄露检测，防止 AI 剧透。",
  },
  {
    icon: "📚",
    title: "剧本可管理、可生成",
    desc: "结构化剧本 Schema + 逻辑校验器，支持 JSON 导入导出；后续可用 AI 生成原创剧本直接入库。",
  },
];

export default function HomePage() {
  return (
    <div className="space-y-12">
      <section className="pt-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          一场不用凑人的<span className="text-amber-400">剧本杀</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-zinc-400">
          真人玩家与 AI 玩家混合对局：读本、搜证、圆桌对峙、投票指凶，全流程由 AI 主持人控场。
          选一个剧本，开一间房，随时开局。
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/rooms/new"
            className="rounded-lg bg-amber-500 px-6 py-2.5 font-medium text-zinc-950 transition hover:bg-amber-400"
          >
            创建房间
          </Link>
          <Link
            href="/scripts"
            className="rounded-lg border border-zinc-700 px-6 py-2.5 font-medium text-zinc-200 transition hover:border-zinc-500"
          >
            浏览剧本库
          </Link>
        </div>
      </section>

      <section className="flex flex-col items-center gap-6">
        <ContinueGames />
        <JoinBox />
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <div className="text-2xl">{f.icon}</div>
            <h3 className="mt-3 font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{f.desc}</p>
          </div>
        ))}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-sm text-zinc-400">
        <h3 className="font-medium text-zinc-200">开始之前</h3>
        <p className="mt-2">
          首次使用请先到{" "}
          <Link href="/settings" className="text-amber-400 hover:underline">
            设置 → AI 接入
          </Link>{" "}
          配置至少一个模型 Provider，并为「DM 主持人」「凶手玩家」「普通 AI 玩家」绑定模型。没有可用模型时，AI 玩家将无法发言。
        </p>
      </section>
    </div>
  );
}
