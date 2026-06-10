export interface ClaudePtyOptions {
  claudePath?: string;
  cwd?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  startupTimeoutMs?: number;
  responseTimeoutMs?: number;
  permissionMode?:
    | 'default'
    | 'acceptEdits'
    | 'auto'
    | 'bypassPermissions'
    | 'plan';
  model?: string;
  systemPrompt?: string;
  scrollback?: number;
}

export enum ClaudeState {
  STARTING = 'STARTING',
  IDLE = 'IDLE',
  RESPONDING = 'RESPONDING',
  TOOL_USE = 'TOOL_USE',
  PERMISSION_PROMPT = 'PERMISSION_PROMPT',
  EXITED = 'EXITED',
  ERROR = 'ERROR',
}

export interface ToolUseInfo {
  toolName: string;
  summary: string;
}

export interface PermissionInfo {
  toolName: string;
  command: string;
}

export interface SendOptions {
  timeoutMs?: number;
  autoApprovePermissions?: boolean;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  model?: string;
  contextPercent?: number;
  limit5hPercent?: number;
  limit5hResetIn?: string;
  limit7dPercent?: number;
  limit7dResetIn?: string;
}

export interface SendResult {
  response: string;
  durationMs: number;
  toolsUsed: ToolUseInfo[];
  usage?: TurnUsage;
}

export interface PipeResult {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  result: string;
  error?: string;
  duration_ms: number;
  num_turns: number;
  tools_used: ToolUseInfo[];
  stop_reason: 'end_turn' | 'error' | 'timeout';
}

export interface PromptOptions {
  claudePath?: string;
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: ClaudePtyOptions['permissionMode'];
  timeoutMs?: number;
  args?: string[];
  env?: Record<string, string>;
}

export type StreamEvent =
  | { type: 'system'; subtype: 'init'; model?: string; permission_mode?: string; cwd?: string }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'assistant'; message: { role: 'assistant'; content: Array<{ type: 'text'; text: string }> } }
  | { type: 'result'; subtype: 'success' | 'error'; is_error: boolean; result: string; error?: string; duration_ms: number; num_turns: number; tools_used: ToolUseInfo[]; stop_reason: string; session_id?: string; usage?: TurnUsage }
  | { type: 'state'; state: string; previous_state: string }
  | { type: 'tool_use'; tool_name: string; summary: string };

export interface Disposable {
  dispose(): void;
}
