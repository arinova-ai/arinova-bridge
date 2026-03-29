export type ProviderId = string;

export interface UploadResult {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface TaskAttachment {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
}

export interface ConversationMember {
  agentId: string;
  agentName: string;
}

export interface ReplyTo {
  role: string;
  content: string;
  senderAgentName?: string;
}

export interface HistoryMessage {
  role: string;
  content: string;
  senderAgentName?: string;
  senderUsername?: string;
  createdAt: string;
}

export interface SendMessageOpts {
  conversationId: string;
  content: string;
  cwd?: string;
  model?: string;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  uploadFile?: (file: Uint8Array, fileName: string, fileType?: string) => Promise<UploadResult>;
  attachments?: TaskAttachment[];
  /** "direct" or "group" */
  conversationType?: string;
  /** User ID of the human who sent the message. */
  senderUserId?: string;
  /** Username of the human who sent the message. */
  senderUsername?: string;
  /** Other agents in the conversation (group only). */
  members?: ConversationMember[];
  /** The message being replied to. */
  replyTo?: ReplyTo;
  /** Recent conversation history (up to 5 messages before current). */
  history?: HistoryMessage[];
  /** Fetch full conversation history with pagination. */
  fetchHistory?: (options?: FetchHistoryOptions) => Promise<FetchHistoryResult>;
}

export interface FetchHistoryOptions {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}

export interface FetchHistoryResult {
  messages: FetchedMessage[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface FetchedMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  content: string;
  status: string;
  senderAgentId?: string;
  senderAgentName?: string;
  senderUserId?: string;
  senderUsername?: string;
  replyToId?: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  attachments?: TaskAttachment[];
}

export interface SendResult {
  text: string;
  sessionId?: string;
  durationMs?: number;
  numTurns?: number;
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

export interface RateLimitEntry {
  status: string;
  rateLimitType: string;
  utilization?: number;
  resetsAt?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
}

export interface UsageInfo {
  context?: {
    contextTokens: number;
    contextWindow?: number;
    maxOutputTokens?: number;
  };
  rateLimits?: RateLimitEntry[];
  window?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
    resetsAt: number;
  };
  totalCostUsd?: number;
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
  getUsageInfo(conversationId: string): UsageInfo | null;
  listSessions(): SessionListEntry[];
  supportedModels(): string[] | null;
  shutdown(): Promise<void>;
}
