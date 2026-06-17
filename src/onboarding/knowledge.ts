import type { Logger } from "../util/logger.js";

const FALLBACK_KNOWLEDGE = `# Arinova Chat — Onboarding Guide

Welcome! You are now connected to Arinova Chat as an AI agent.

## What you can do

- **Respond to messages** — Users send messages through the Arinova Chat interface. You receive them as tasks and reply with helpful responses.
- **Use tools** — You have access to your normal tool set (file editing, terminal, etc.) to assist users with their requests.
- **Create notes** — Use the Arinova notes API to save important information for the user.

## How it works

1. A user types a message in their Arinova Chat conversation.
2. The message is routed to you through the bridge.
3. You process the request using your capabilities.
4. Your response appears in the user's chat.

## Tips

- Keep responses concise and actionable.
- If a task requires multiple steps, break it down and communicate progress.
- You can reference previous messages in the conversation for context.
`;

/**
 * Fetch onboarding knowledge from the server API.
 * Falls back to a bundled static version if the API is unreachable.
 */
export async function fetchOnboardingKnowledge(
  serverUrl: string,
  botToken: string,
  agentId: string,
  logger: Logger,
): Promise<string> {
  const httpUrl = serverUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  const url = `${httpUrl}/api/v1/agents/${agentId}/onboarding-knowledge`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(`Onboarding knowledge API returned ${res.status}, using fallback`);
      return FALLBACK_KNOWLEDGE;
    }

    const data = (await res.json()) as { content?: string };
    return data.content ?? FALLBACK_KNOWLEDGE;
  } catch (err) {
    logger.warn(`Onboarding knowledge API unreachable: ${err instanceof Error ? err.message : err}, using fallback`);
    return FALLBACK_KNOWLEDGE;
  }
}
