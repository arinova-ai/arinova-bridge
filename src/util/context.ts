import type { SendMessageOpts } from "../providers/types.js";

/**
 * Build a context prefix from group conversation metadata, reply-to info,
 * and recent history. Returns an empty string if there's nothing to prepend.
 *
 * The prefix is designed to be prepended to the user's message so that
 * providers (which may not have access to the chat-level context) can
 * understand the conversational setting.
 */
export function buildContextPrefix(opts: SendMessageOpts): string {
  const parts: string[] = [];

  // Group conversation context
  if (opts.conversationType === "group" && opts.members?.length) {
    const names = opts.members.map((m) => m.agentName).join(", ");
    parts.push(`[Group conversation — other agents: ${names}]`);
  }

  // Who is speaking
  if (opts.senderUsername) {
    parts.push(`[Message from user: ${opts.senderUsername}]`);
  }

  // Recent history (only include if there IS history)
  if (opts.history?.length) {
    const lines = opts.history.map((h) => {
      const sender = h.senderUsername ?? h.senderAgentName ?? h.role;
      return `${sender}: ${h.content}`;
    });
    parts.push(`[Recent history]\n${lines.join("\n")}\n[/Recent history]`);
  }

  // Reply-to context
  if (opts.replyTo) {
    const sender = opts.replyTo.senderAgentName ?? opts.replyTo.role;
    parts.push(`[Replying to ${sender}: ${opts.replyTo.content}]`);
  }

  if (parts.length === 0) return "";
  return parts.join("\n") + "\n\n";
}
