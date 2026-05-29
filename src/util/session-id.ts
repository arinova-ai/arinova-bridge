/** Prefix used by the A2A (agent-to-agent) routing layer. */
export const A2A_PREFIX = "a2a:";

/**
 * Check whether a conversationId / sessionId belongs to a specific agent.
 *
 * Convention: session IDs are formatted as `<agentName>:<suffix>`,
 * e.g. `"alice:default"`.
 */
export function isAgentSession(conversationId: string, agentName: string): boolean {
  return conversationId.startsWith(`${agentName}:`);
}

/**
 * Extract the A2A recursion depth encoded in a conversationId.
 *
 * A2A conversation IDs look like `"a2a:<depth>:<rest>"`.
 * Returns 0 for non-A2A IDs.
 */
export function parseA2aDepth(conversationId: string): number {
  if (!conversationId.startsWith(A2A_PREFIX)) return 0;
  const parts = conversationId.split(":");
  return parseInt(parts[1], 10) || 0;
}
