import type { ArinovaAgent } from "@arinova-ai/agent-sdk";
import type { CommandHandler } from "../commands/handler.js";
import type { Provider } from "../providers/types.js";
import type { ResolvedAgent } from "../config.js";
import type { HudWebSocket } from "../claude/hud-ws.js";

export interface ActiveAgent {
  agent: ArinovaAgent;
  name: string;
  hudWs: HudWebSocket;
  commandHandler: CommandHandler;
  provider: Provider;
  agentConfig: ResolvedAgent;
}

/** Recorded task entry for --history. */
export interface TaskRecord {
  agent: string;
  content: string;
  responsePreview: string;
  durationMs: number;
  costUsd?: number;
  model?: string;
  timestamp: number;
}

// --- IPC Requests ---

export interface IpcListAgentsRequest {
  id: number;
  method: "list-agents";
}

export interface IpcDeliverRequest {
  id: number;
  method: "deliver";
  params: {
    target: string;
    content: string;
    source?: string;  // sender agent/user name for logging
    cwd?: string;
    model?: string;
    wait?: boolean;  // default true; false = fire-and-forget
  };
}

export interface IpcAgentStatusRequest {
  id: number;
  method: "agent-status";
  params: { target: string };
}

export interface IpcPingRequest {
  id: number;
  method: "ping";
  params: { target: string };
}

export interface IpcAgentCostRequest {
  id: number;
  method: "agent-cost";
  params: { target?: string };  // omit = all agents
}

export interface IpcAgentStopRequest {
  id: number;
  method: "agent-stop";
  params: { target: string };
}

export interface IpcAgentResetRequest {
  id: number;
  method: "agent-reset";
  params: { target: string };
}

export interface IpcHandoffRequest {
  id: number;
  method: "handoff";
  params: { from: string; to: string };
}

export interface IpcWatchRequest {
  id: number;
  method: "watch";
}

export interface IpcHistoryRequest {
  id: number;
  method: "history";
  params: { target?: string; limit?: number };
}

// --- Cron IPC Requests ---

export interface IpcCronAddRequest {
  id: number;
  method: "cron-add";
  params: { agent: string; expr: string; message: string; maxRuns?: number };
}

export interface IpcCronListRequest {
  id: number;
  method: "cron-list";
  params: { agent?: string };
}

export interface IpcCronDeleteRequest {
  id: number;
  method: "cron-delete";
  params: { agent: string; id: string };
}

export type IpcRequest =
  | IpcListAgentsRequest
  | IpcDeliverRequest
  | IpcAgentStatusRequest
  | IpcPingRequest
  | IpcAgentCostRequest
  | IpcAgentStopRequest
  | IpcAgentResetRequest
  | IpcHandoffRequest
  | IpcWatchRequest
  | IpcHistoryRequest
  | IpcCronAddRequest
  | IpcCronListRequest
  | IpcCronDeleteRequest;

// --- IPC Responses ---

export interface IpcSuccessResponse {
  id: number;
  result: unknown;
}

export interface IpcErrorResponse {
  id: number;
  error: { code: number; message: string };
}

export type IpcResponse = IpcSuccessResponse | IpcErrorResponse;
