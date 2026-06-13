// Module augmentation for @arinova-ai/agent-sdk.
//
// The agent-sdk forwards the authoring agent's identity at runtime — see
// @arinova-ai/agent-sdk >= 0.0.19-staging.6 (arinova-packages,
// packages/agent-sdk: TaskContext.senderAgentId / senderAgentName, forwarded
// from the server's task payload). The bridge currently pins staging.5, whose
// published .d.ts predates these fields, so we forward-declare them here to
// consume values the runtime already provides.
//
// REMOVE this file once the bridge bumps its @arinova-ai/agent-sdk dependency
// to >= 0.0.19-staging.6 (the published types will then carry these fields).
import "@arinova-ai/agent-sdk";

declare module "@arinova-ai/agent-sdk" {
  interface TaskContext {
    /** Agent ID of the agent that authored the message (agent-to-agent / group). */
    senderAgentId?: string;
    /**
     * Display handle of the agent that authored the message. Prefer this over
     * `senderUsername` (which the backend may fill with the workspace owner)
     * when attributing agent-authored messages.
     */
    senderAgentName?: string;
  }
}
