export type Purpose = "dm" | "culprit" | "player" | "generator" | "embedding";

export type BindingSlot = Purpose | "tts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 见 prompt-segments.ts：提供时预算裁剪按分段层级降级。 */
export interface PromptSegments {
  system: string;
  log: string;
  anchoredHead: string;
  /** 按先丢→后丢排序 */
  droppable: string[];
  anchoredTail: string;
}

export interface PromptAssembly {
  messages: ChatMessage[];
  segments: PromptSegments;
}

export interface ChatOptions {
  /** 用途槽位，决定用哪个模型绑定 */
  purpose: Purpose;
  messages: ChatMessage[];
  /** 与 messages 对应的分段结构（buildPlayerContext/buildDmContext 的返回）；提供时按分层降级裁剪。 */
  segments?: PromptSegments;
  /** 期望返回 JSON（仍需调用方自行解析，见 extractJson） */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  gameId?: string | null;
  /** 由引擎传入的可取消信号；未提供时由客户端创建超时信号。 */
  abortSignal?: AbortSignal;
  /** 贯穿重试/fallback 的逻辑请求标识；缺省由客户端生成。 */
  requestId?: string;
  /** 引擎生成代次，用于诊断迟到输出。 */
  generationId?: string;
  /** 细分任务类型，便于按任务统计成本与失败。 */
  taskType?: string;
  /** 解码控制：缺省时请求体与旧版逐字节一致；网关拒绝未知字段时客户端自动去参重试。 */
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
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
  maxTokens: number | null;
  fallbackSlot: string | null;
  /** null 表示管理员尚未声明上下文窗口，预算模式不得猜测。 */
  contextWindow: number | null;
  capabilities: {
    system: boolean;
    json: boolean;
  };
}
