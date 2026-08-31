export type Purpose = "dm" | "culprit" | "player" | "generator";

export type BindingSlot = Purpose | "tts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** 用途槽位，决定用哪个模型绑定 */
  purpose: Purpose;
  messages: ChatMessage[];
  /** 期望返回 JSON（仍需调用方自行解析，见 extractJson） */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  gameId?: string | null;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  providerName: string;
  modelId: string;
}

export interface ResolvedBinding {
  providerId: string;
  providerName: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  temperature: number | null;
  fallbackSlot: string | null;
}
