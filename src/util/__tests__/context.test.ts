import { describe, it, expect } from "vitest";
import { buildContextPrefix } from "../context.js";
import type { SendMessageOpts } from "../../providers/types.js";

/** Minimal opts that satisfy the required fields of SendMessageOpts. */
function baseOpts(overrides: Partial<SendMessageOpts> = {}): SendMessageOpts {
  return {
    conversationId: "conv-1",
    content: "hello",
    onChunk: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildContextPrefix
// ---------------------------------------------------------------------------
describe("buildContextPrefix", () => {
  // --- empty / no-context cases -------------------------------------------

  it("returns empty string when no optional context is provided", () => {
    expect(buildContextPrefix(baseOpts())).toBe("");
  });

  // --- group conversation -------------------------------------------------

  it("includes group member names when conversationType is 'group' with members", () => {
    const result = buildContextPrefix(
      baseOpts({
        conversationType: "group",
        members: [
          { agentId: "a1", agentName: "Alice" },
          { agentId: "a2", agentName: "Bob" },
        ],
      }),
    );
    expect(result).toContain("[Group conversation — other agents: Alice, Bob]");
  });

  it("does not include group line when conversationType is 'group' but members is empty", () => {
    const result = buildContextPrefix(baseOpts({ conversationType: "group", members: [] }));
    expect(result).not.toContain("Group conversation");
  });

  it("does not include group line when conversationType is not 'group'", () => {
    const result = buildContextPrefix(
      baseOpts({
        conversationType: "direct",
        members: [{ agentId: "a1", agentName: "Alice" }],
      }),
    );
    expect(result).not.toContain("Group conversation");
  });

  // --- sender username ----------------------------------------------------

  it("includes sender username when provided", () => {
    const result = buildContextPrefix(baseOpts({ senderUsername: "jan" }));
    expect(result).toContain("[Message from user: jan]");
  });

  it("does not include sender line when senderUsername is undefined", () => {
    const result = buildContextPrefix(baseOpts());
    expect(result).not.toContain("Message from user");
  });

  // --- bridgeSessionContext (primary history path) -------------------------

  it("includes bridge session context when provided", () => {
    const result = buildContextPrefix(baseOpts({ bridgeSessionContext: "user: hi\nassistant: hey" }));
    expect(result).toContain("[Recent history]\nuser: hi\nassistant: hey\n[/Recent history]");
  });

  it("prefers bridgeSessionContext over history when both are provided", () => {
    const result = buildContextPrefix(
      baseOpts({
        bridgeSessionContext: "bridge ctx",
        history: [{ role: "user", content: "old", createdAt: "2024-01-01" }],
      }),
    );
    expect(result).toContain("bridge ctx");
    expect(result).not.toContain("old");
  });

  // --- history fallback (lines 30-36) -------------------------------------

  it("falls back to history when bridgeSessionContext is absent", () => {
    const result = buildContextPrefix(
      baseOpts({
        history: [
          { role: "user", content: "ping", senderUsername: "alice", createdAt: "2024-01-01" },
          { role: "assistant", content: "pong", senderAgentName: "Bot", createdAt: "2024-01-01" },
        ],
      }),
    );
    expect(result).toContain("[Recent history]");
    // senderUsername takes priority in the ?? chain
    expect(result).toContain("alice: ping");
    // senderAgentName is next
    expect(result).toContain("Bot: pong");
    expect(result).toContain("[/Recent history]");
  });

  it("uses role as sender when both senderUsername and senderAgentName are missing", () => {
    const result = buildContextPrefix(
      baseOpts({
        history: [{ role: "system", content: "init", createdAt: "2024-01-01" }],
      }),
    );
    expect(result).toContain("system: init");
  });

  it("uses senderAgentName when senderUsername is missing", () => {
    const result = buildContextPrefix(
      baseOpts({
        history: [{ role: "assistant", content: "hi", senderAgentName: "Claude", createdAt: "2024-01-01" }],
      }),
    );
    expect(result).toContain("Claude: hi");
  });

  it("does not include history section when history array is empty", () => {
    const result = buildContextPrefix(baseOpts({ history: [] }));
    expect(result).not.toContain("Recent history");
  });

  // --- replyTo (lines 40-42) ----------------------------------------------

  it("includes replyTo with senderAgentName when present", () => {
    const result = buildContextPrefix(
      baseOpts({
        replyTo: { role: "assistant", content: "original msg", senderAgentName: "Bot" },
      }),
    );
    expect(result).toContain("[Replying to Bot: original msg]");
  });

  it("falls back to role when replyTo.senderAgentName is missing", () => {
    const result = buildContextPrefix(
      baseOpts({
        replyTo: { role: "user", content: "some text" },
      }),
    );
    expect(result).toContain("[Replying to user: some text]");
  });

  // --- combined output / formatting (line 45-46) --------------------------

  it("joins all parts with newlines and appends trailing double newline", () => {
    const result = buildContextPrefix(
      baseOpts({
        conversationType: "group",
        members: [{ agentId: "a1", agentName: "Alice" }],
        senderUsername: "jan",
        bridgeSessionContext: "ctx here",
        replyTo: { role: "user", content: "hey", senderAgentName: "Jan" },
      }),
    );

    // Should end with two newlines (the trailing \n\n)
    expect(result.endsWith("\n\n")).toBe(true);

    // All four sections should be present
    expect(result).toContain("[Group conversation");
    expect(result).toContain("[Message from user: jan]");
    expect(result).toContain("[Recent history]");
    expect(result).toContain("[Replying to Jan: hey]");
  });

  it("returns empty string (not '\\n\\n') when parts array stays empty", () => {
    // conversationType is not 'group', no sender, no history, no replyTo
    const result = buildContextPrefix(baseOpts({ conversationType: "direct" }));
    expect(result).toBe("");
  });
});
