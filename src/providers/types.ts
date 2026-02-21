export type ProviderId = string;

export interface UploadResult {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface SendMessageOpts {
  conversationId: string;
  content: string;
  cwd?: string;
  model?: string;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  uploadFile?: (file: Uint8Array, fileName: string, fileType?: string) => Promise<UploadResult>;
}

export interface SendResult {
  text: string;
  sessionId?: string;
}

export interface SessionOpts {
  cwd?: string;
  model?: string;
  compact?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  alive: boolean;
  cwd: string;
  model?: string;
}

export interface CostInfo {
  totalCostUsd?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface SessionListEntry {
  providerId: ProviderId;
  sessionId: string;
  conversationId: string;
  alive: boolean;
  status: "ready" | "busy" | "idle" | "error";
  cwd: string;
  model?: string;
  lastActivity?: number;
}

export interface Provider {
  readonly id: ProviderId;
  readonly type: string;
  readonly displayName: string;

  sendMessage(opts: SendMessageOpts): Promise<SendResult>;
  interrupt(conversationId: string): void;
  resetSession(conversationId: string, opts?: SessionOpts): Promise<void>;
  resumeSession(
    conversationId: string,
    sessionId: string,
    opts?: SessionOpts,
  ): Promise<boolean>;
  getSessionInfo(conversationId: string): SessionInfo | null;
  getCostInfo(conversationId: string): CostInfo | null;
  listSessions(): SessionListEntry[];
  supportedModels(): string[] | null;
  shutdown(): Promise<void>;
}
