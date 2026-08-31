export interface ProviderPreset {
  key: string;
  label: string;
  protocol: "openai_compatible" | "anthropic";
  baseUrl: string;
  /** 常见模型，作为「测试连接」失败时的手动备选 */
  commonModels: string[];
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "deepseek",
    label: "DeepSeek",
    protocol: "openai_compatible",
    baseUrl: "https://api.deepseek.com/v1",
    commonModels: ["deepseek-chat", "deepseek-reasoner"],
    note: "性价比高，deepseek-chat 适合 AI 玩家，deepseek-reasoner 适合 DM/凶手",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    protocol: "openai_compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    commonModels: ["glm-4.7", "glm-4.7-air", "glm-4.7-flash"],
    note: "国内访问稳定，glm-4.7-flash 免费/低价适合路人角色",
  },
  {
    key: "qwen",
    label: "阿里通义 Qwen",
    protocol: "openai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    commonModels: ["qwen-max", "qwen-plus", "qwen-turbo"],
  },
  {
    key: "moonshot",
    label: "月之暗面 Moonshot",
    protocol: "openai_compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    commonModels: ["kimi-k2", "moonshot-v1-32k"],
  },
  {
    key: "openai",
    label: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    commonModels: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    protocol: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    commonModels: ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"],
    note: "一个 key 聚合数百家模型",
  },
  {
    key: "xiaomi_mimo",
    label: "小米 MiMo",
    protocol: "openai_compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    commonModels: ["mimo-v2.5-pro", "mimo-v2.5"],
    note: "按量付费用此地址；Token Plan 把 Base URL 换成 https://token-plan-cn.xiaomimimo.com/v1（Key 以 tp- 开头）。协议选 OpenAI 兼容。",
  },
  {
    key: "ollama",
    label: "Ollama 本地模型",
    protocol: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    commonModels: ["qwen3:14b", "llama3.1:8b"],
    note: "完全免费本地推理，适合调试流程， apiKey 随意填",
  },
  {
    key: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    commonModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  },
];

export const BINDING_SLOTS: Array<{
  key: "dm" | "culprit" | "player" | "generator" | "tts";
  label: string;
  description: string;
}> = [
  { key: "dm", label: "DM 主持人", description: "控场、旁白、复盘，建议用最强的模型" },
  { key: "culprit", label: "凶手玩家", description: "隐瞒质量直接决定游戏体验，建议用强模型" },
  { key: "player", label: "普通 AI 玩家", description: "推理与表演，可用性价比模型" },
  { key: "generator", label: "剧本生成", description: "AI 生成原创剧本，建议用强模型" },
  { key: "tts", label: "语音合成", description: "AI 发言配音（OpenAI /audio/speech 兼容协议）" },
];
