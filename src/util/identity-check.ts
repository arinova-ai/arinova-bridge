import type { Logger } from "./logger.js";

interface ActionCaller {
  callAction(action: string, args: Record<string, unknown>): Promise<{
    status: string;
    result?: Record<string, unknown> | null;
  }>;
}

/**
 * Call arinova.agent.get_status to verify the bot token maps to the
 * expected agent. Throws on mismatch, network failure, or missing identity.
 */
export async function verifyAgentIdentity(
  agent: ActionCaller,
  expectedAgentName: string,
  logger: Logger,
): Promise<void> {
  const result = await agent.callAction("arinova.agent.get_status", {});
  if (result.status !== "success" || !result.result) {
    throw new Error(
      `identity verification failed — get_status returned status="${result.status}"`,
    );
  }
  const verifiedName = result.result.name as string | undefined;
  if (!verifiedName) {
    throw new Error(
      "identity verification failed — get_status returned no agent name",
    );
  }
  if (verifiedName.toLowerCase() !== expectedAgentName.toLowerCase()) {
    throw new Error(
      `identity mismatch — server identifies this bot token as agent "${verifiedName}" ` +
      `but expected "${expectedAgentName}". Check bot token assignment.`,
    );
  }
  logger.info(`[${expectedAgentName}] identity verified via get_status`);
}
