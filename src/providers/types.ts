import type { ToolCallReport } from "../claude/process.js";

export type { ToolCallReport };

export type ProviderId = string;

/** Fire-and-forget reporter for completed tool calls. */
export type ReportToolCall = (report: ToolCallReport) => void | Promise<void>;

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
  /** Agent system prompt loaded from agents/*.md files. */
  systemPrompt?: string;
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
  /** Agent ID of the agent that authored the message (agent-to-agent / group). */
  senderAgentId?: string;
  /**
   * Display handle of the agent that authored the message. When set, the
   * sender is an agent (not a human) and `buildContextPrefix` attributes the
   * message to this handle — not `senderUsername`, which the backend may fill
   * with the workspace owner for agent-authored messages.
   */
  senderAgentName?: string;
  /** Other agents in the conversation (group only). */
  members?: ConversationMember[];
  /** The message being replied to. */
  replyTo?: ReplyTo;
  /** Recent conversation history (up to 5 messages before current). */
  history?: HistoryMessage[];
  /** Fetch full conversation history with pagination. */
  fetchHistory?: (options?: FetchHistoryOptions) => Promise<FetchHistoryResult>;
  /** Pre-built bridge session context string (replaces history when present). */
  bridgeSessionContext?: string;
  /** When true, queue behind any in-flight turn instead of aborting it. */
  queue?: boolean;
  /**
   * Invoked once per tool call completion (fire-and-forget). Plumbed through
   * to ClaudeProcess so each `tool_result` block can be reported to the
   * Arinova server's tool_call_logs table. Errors are logged and swallowed.
   */
  reportToolCall?: (report: ToolCallReport) => void | Promise<void>;
  /** UUID of the user message that triggered this send (propagated to tool call reports). */
  messageId?: string;
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
  restartProcess?: boolean;
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

export interface WarmupOpts {
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  /**
   * Wire the tool-call reporter at warmup so the pre-spawned ClaudeProcess
   * reports tool calls from the very first sendMessage. Without this, warmup
   * creates a process whose `processOpts.reportToolCall` is undefined, and
   * subsequent sendMessage calls cannot retroactively attach the reporter.
   */
  reportToolCall?: (report: ToolCallReport) => void | Promise<void>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly type: string;
  readonly displayName: string;

  /** Pre-create an LLM session so it's ready for immediate use (e.g. A2A). */
  warmup(conversationId: string, opts?: WarmupOpts): void;
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
  /** Set an environment variable for spawned CLI processes. */
  setEnv(key: string, value: string): void;
  /** Register a per-agent MCP config path (overrides the provider-level default). */
  setAgentMcpConfig?(agentName: string, mcpConfigPath: string): void;
  /** Register per-agent environment for MCP subprocesses launched by the provider. */
  setAgentMcpEnv?(agentName: string, env: Record<string, string>): void;
}
