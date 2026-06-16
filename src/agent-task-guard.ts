import type { TaskContext } from "@arinova-ai/agent-sdk";

/** Minimal logger surface the guard needs. */
export interface GuardLogger {
  error: (msg: string) => void;
}

/**
 * Reject a task that arrived without a `conversationId`.
 *
 * agent-sdk 0.0.19-staging.7 made `TaskContext.conversationId` optional, but the
 * bridge's single-session-per-agent model has nothing to reply to or scope Note
 * calls against without one.
 *
 * Crucially this sends a terminal error via `ctx.sendError` rather than letting
 * the caller bare-`return`: only `sendComplete`/`sendError` trigger the SDK's
 * `markFinished()`, which stops the heartbeat, deletes the active task, releases
 * the agent-wide lock and drains the queue. A silent return would leak the task
 * and deadlock every subsequent task on this agent.
 */
export function rejectTaskWithoutConversation(
  ctx: Pick<TaskContext, "sendError">,
  agentName: string,
  log: GuardLogger,
): void {
  log.error(`[${agentName}] task received without conversationId — cannot process`);
  ctx.sendError("Task received without a conversationId — the bridge cannot process it");
}
