import type { SendMessageOpts } from "../providers/types.js";

/**
 * Build a context prefix from group conversation metadata, reply-to info,
 * and bridge session history. Returns an empty string if there's nothing
 * to prepend.
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

  // Who is speaking. Agent identity wins over senderUsername: for
  // agent-authored messages the backend may populate senderUsername with the
  // workspace owner, so an `[Message from user: <owner>]` line would
  // mis-attribute the sender and corrupt mention/reply routing. When
  // senderAgentName is present the message came from an agent.
  if (opts.senderAgentName) {
    parts.push(`[Message from agent: ${opts.senderAgentName}]`);
  } else if (opts.senderUsername) {
    parts.push(`[Message from user: ${opts.senderUsername}]`);
  }

  // Bridge session history (managed by BridgeSessionStore, replaces old
  // ctx.history which was limited to 5 messages from Arinova SDK).
  if (opts.bridgeSessionContext) {
    parts.push(`[Recent history]\n${opts.bridgeSessionContext}\n[/Recent history]`);
  } else if (opts.history?.length) {
    // Fallback: use Arinova SDK history if no bridge session context
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

/**
 * Strip bridge-injected context blocks from a provider response.
 *
 * The Claude CLI PTY parser uses the `❯` user-prompt line as the boundary
 * between user input and assistant response. When we send a multi-line prompt
 * containing blocks like [Recent history]\n...\n[/Recent history], only the
 * first line carries `❯`; the continuation lines leak into the parsed
 * response. We scrub them here before the text reaches the UI or the
 * session store.
 */
export function stripInjectedContext(text: string): string {
  if (!text) return text;

  let out = text;

  // Multi-line blocks with explicit end markers — non-greedy, dot-all
  out = out.replace(/\[Recent history\][\s\S]*?\[\/Recent history\]\s*/g, "");
  out = out.replace(/\[Conversation summary\][\s\S]*?\[\/Conversation summary\]\s*/g, "");

  // Fork wrapper: "[Fork context from main session]\n...\n\n[Fork task]\n"
  out = out.replace(/\[Fork context from main session\][\s\S]*?\[Fork task\]\s*/g, "");

  // [Sender memories — from X]\n- item\n- item — runs until a blank line
  out = out.replace(/\[Sender memories[^\]]*\][^\n]*(?:\n(?:-[^\n]*|\s*))*\n?/g, "");

  // Single-line bracket tags
  out = out.replace(/^\[Group conversation[^\]]*\]\s*\n?/gm, "");
  out = out.replace(/^\[Message from user:[^\]]*\]\s*\n?/gm, "");
  out = out.replace(/^\[Message from agent:[^\]]*\]\s*\n?/gm, "");
  out = out.replace(/^\[Replying to [^\]]*\]\s*\n?/gm, "");

  // user-current-message wrapper from fork path
  out = out.replace(/<user-current-message>[\s\S]*?<\/user-current-message>\s*/g, "");

  return out.replace(/^\s+/, "");
}

/**
 * True when content begins with an injection-block opener whose closer
 * hasn't been seen yet (i.e. mid-stream and the rest of the block is
 * still arriving). Used by the PTY parser to suppress streaming emit
 * for partial bridge-injected blocks that the `❯` boundary heuristic
 * would otherwise leak as response text.
 */
export function hasUnclosedInjectionBlock(text: string): boolean {
  if (!text) return false;
  const trimmed = text.replace(/^\s+/, "");
  const pairs: Array<[RegExp, RegExp]> = [
    [/^\[Recent history\]/, /\[\/Recent history\]/],
    [/^\[Conversation summary\]/, /\[\/Conversation summary\]/],
    [/^\[Fork context from main session\]/, /\[Fork task\]/],
    [/^<user-current-message>/, /<\/user-current-message>/],
  ];
  for (const [opener, closer] of pairs) {
    if (opener.test(trimmed) && !closer.test(trimmed)) return true;
  }
  return false;
}
