// JSON-RPC 2.0 message types for Codex app-server protocol

// --- Core JSON-RPC types ---

export interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

/** Server-to-client request (has id + method, no result/error). */
export interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: unknown;
}

// --- Initialize ---

export interface InitializeParams {
  clientInfo: { name: string; version: string; title: string | null };
  capabilities: { experimental_api?: boolean };
}

export interface InitializeResult {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
}

// --- Thread lifecycle ---

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  sandbox?: unknown;
  config?: unknown;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: string | null;
  ephemeral?: boolean;
  experimentalRawEvents?: boolean;
  persistExtendedHistory?: boolean;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
  history?: unknown;
  path?: string | null;
}

export interface ThreadInfo {
  id: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  path: string;
  cwd: string;
  cliVersion: string;
  source: string;
  name: string | null;
  turns: unknown[];
}

export interface ThreadStartResult {
  thread: ThreadInfo;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: string;
}

// --- Turn ---

export interface UserInputText {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInputText[];
  cwd?: string | null;
  approvalPolicy?: string | null;
  model?: string | null;
}

export interface TurnInfo {
  id: string;
  items: unknown[];
  status: string;
  error: string | null;
}

export interface TurnStartResult {
  turn: TurnInfo;
}

// --- Notifications (server → client) ---

export interface ThreadStartedNotification {
  thread: ThreadInfo;
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: TurnInfo;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: TurnInfo;
}

export interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface TokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsage;
    last: TokenUsage;
    modelContextWindow: number | null;
  };
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: string | null;
}

export interface RateLimitsUpdatedNotification {
  rateLimits: RateLimitSnapshot;
}

// --- Server requests (approval) ---

export interface CommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
  availableDecisions: string[];
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string;
  grantRoot: string;
}

export interface ApprovalResponse {
  decision: string;
}
