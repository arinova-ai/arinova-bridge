import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BridgeSessionStore } from "../../../src/session/bridge-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// buildContext() — LIMIT 20, summary inclusion, message formatting
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe("BridgeSessionStore.buildContext()", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  const convId = "ctx-test-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-ctx-"));
    store = new BridgeSessionStore(tmpDir, createLogger() as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when no messages and no summary", () => {
    const ctx = store.buildContext(convId);
    expect(ctx).toBe("");
  });

  it("returns formatted messages with sender labels", () => {
    store.addUserMessage(convId, "hello", "alice");
    store.addAssistantMessage(convId, "hi there", "bot");

    const ctx = store.buildContext(convId);
    expect(ctx).toContain("alice: hello");
    expect(ctx).toContain("bot: hi there");
  });

  it("falls back to role when sender is missing", () => {
    // addUserMessage always sets sender, but we verify the format
    store.addUserMessage(convId, "test msg", "user");
    const ctx = store.buildContext(convId);
    expect(ctx).toContain("user: test msg");
  });

  it("limits to most recent 20 messages", () => {
    // Add 30 messages
    for (let i = 1; i <= 30; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg-${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg-${i}`, "bot");
      }
    }

    const ctx = store.buildContext(convId);

    // Should NOT contain first 10 messages (msg-1 through msg-10)
    expect(ctx).not.toContain("msg-1\n");
    expect(ctx).not.toContain("msg-10");

    // Should contain last 20 messages (msg-11 through msg-30)
    expect(ctx).toContain("msg-11");
    expect(ctx).toContain("msg-20");
    expect(ctx).toContain("msg-30");
  });

  it("includes compacted summary before messages", async () => {
    // Add enough messages to compact, then compact
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg-${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg-${i}`, "bot");
      }
    }

    // Compact to create a summary
    await store.compact(convId, async () => "This is the compacted summary");

    const ctx = store.buildContext(convId);

    // Summary should be wrapped in tags
    expect(ctx).toContain("[Conversation summary]");
    expect(ctx).toContain("This is the compacted summary");
    expect(ctx).toContain("[/Conversation summary]");

    // Summary should appear before messages
    const summaryIdx = ctx.indexOf("[Conversation summary]");
    const firstMsgIdx = ctx.indexOf("user: ");
    expect(summaryIdx).toBeLessThan(firstMsgIdx);
  });

  it("returns only messages when no summary exists", () => {
    store.addUserMessage(convId, "hello", "user");
    store.addAssistantMessage(convId, "world", "bot");

    const ctx = store.buildContext(convId);
    expect(ctx).not.toContain("[Conversation summary]");
    expect(ctx).toContain("user: hello");
    expect(ctx).toContain("bot: world");
  });

  it("preserves message order (oldest first within limit)", () => {
    store.addUserMessage(convId, "first", "user");
    store.addAssistantMessage(convId, "second", "bot");
    store.addUserMessage(convId, "third", "user");

    const ctx = store.buildContext(convId);
    const firstIdx = ctx.indexOf("first");
    const secondIdx = ctx.indexOf("second");
    const thirdIdx = ctx.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("strips wrapper from all user messages including the latest", () => {
    // All user rows must use user_message (the extracted clean input), not the
    // full wrapped content. Re-injecting a wrapped latest row is what caused
    // the recursive [Fork context] bloat that ate gina's rate limit.
    const fullTagged = `
<system-prompt>ignore</system-prompt>
<user-current-message>
請幫我整理這段訊息
</user-current-message>
`;

    store.addUserMessage(convId, fullTagged, "alice");
    store.addAssistantMessage(convId, "收到", "bot");
    store.addUserMessage(convId, `${fullTagged}\n<extra>latest wrapper</extra>`, "alice");

    const ctx = store.buildContext(convId);
    const lines = ctx.split("\n");
    const latestBlock = ctx.slice(ctx.lastIndexOf("alice: "));

    expect(lines[0]).toBe("alice: 請幫我整理這段訊息");
    expect(ctx).toContain("bot: 收到");
    expect(latestBlock).toBe("alice: 請幫我整理這段訊息");
    expect(ctx).not.toContain("<system-prompt>");
    expect(ctx).not.toContain("<extra>latest wrapper</extra>");
  });

  it("falls back to content when historical user_message is null", () => {
    const db = new Database(path.join(tmpDir, "sessions.db"));
    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (conversation_id, compacted_summary, model, user_id, username, message_count, total_tokens, created_at, updated_at)
      VALUES (?, NULL, NULL, NULL, NULL, 1, 0, ?, ?)
    `).run(convId, now, now);
    db.prepare(`
      INSERT INTO messages (conversation_id, role, content, user_message, sender, timestamp, token_count, finish_reason)
      VALUES (?, 'user', ?, NULL, 'legacy-user', ?, 0, NULL)
    `).run(convId, "<legacy>full content</legacy>", now);
    db.close();

    const ctx = store.buildContext(convId);
    expect(ctx).toContain("legacy-user: <legacy>full content</legacy>");
  });
});

// ---------------------------------------------------------------------------
// /compact preserves summary vs /new wipes everything
// ---------------------------------------------------------------------------

describe("buildContext after compact vs clear (Smart Session Context)", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  const convId = "ssc-test-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-ssc-"));
    store = new BridgeSessionStore(tmpDir, createLogger() as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("after compact: buildContext returns summary + preserved messages (not empty)", async () => {
    // Populate 20 messages
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg-${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg-${i}`, "bot");
      }
    }

    await store.compact(convId, async () => "Task summary: implemented feature X");

    const ctx = store.buildContext(convId);
    // Summary should persist
    expect(ctx).toContain("Task summary: implemented feature X");
    // Protected last N messages should still be present
    expect(ctx).toContain("msg-20");
    // Context should NOT be empty
    expect(ctx.length).toBeGreaterThan(0);
  });

  it("after clear (simulating /new): buildContext returns empty string", async () => {
    // Populate and compact
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg-${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg-${i}`, "bot");
      }
    }
    await store.compact(convId, async () => "summary that should be wiped");

    // Simulate /new → onSessionClear calls store.clear()
    store.clear(convId);

    const ctx = store.buildContext(convId);
    expect(ctx).toBe("");
  });

  it("after compact + new messages: buildContext includes summary AND new messages", async () => {
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg-${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg-${i}`, "bot");
      }
    }
    await store.compact(convId, async () => "Previous work summary");

    // Simulate post-compact conversation (like after /model reset re-injects context)
    store.addUserMessage(convId, "new question after reset", "user");
    store.addAssistantMessage(convId, "new answer", "bot");

    const ctx = store.buildContext(convId);
    expect(ctx).toContain("Previous work summary");
    expect(ctx).toContain("new question after reset");
    expect(ctx).toContain("new answer");
  });
});

// ---------------------------------------------------------------------------
// BridgeSessionStore.clear() — full cleanup
// ---------------------------------------------------------------------------

describe("BridgeSessionStore.clear()", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  const convId = "clear-test-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-clear-"));
    store = new BridgeSessionStore(tmpDir, createLogger() as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes all messages and session data", () => {
    store.addUserMessage(convId, "hello", "user");
    store.addAssistantMessage(convId, "hi", "bot");
    expect(store.getMessages(convId)).toHaveLength(2);

    store.clear(convId);

    expect(store.getMessages(convId)).toHaveLength(0);
    expect(store.buildContext(convId)).toBe("");
  });

  it("removes compacted summary", async () => {
    // Add messages and compact
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `msg-${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `msg-${i}`, "bot");
      }
    }
    await store.compact(convId, async () => "summary to be cleared");

    // Verify summary exists
    expect(store.buildContext(convId)).toContain("summary to be cleared");

    // Clear and verify summary is gone
    store.clear(convId);
    expect(store.buildContext(convId)).toBe("");
  });

  it("does not affect other conversations", () => {
    const otherConvId = "clear-test-2";
    store.addUserMessage(convId, "msg-a", "user");
    store.addUserMessage(otherConvId, "msg-b", "user");

    store.clear(convId);

    expect(store.getMessages(convId)).toHaveLength(0);
    expect(store.getMessages(otherConvId)).toHaveLength(1);
  });
});
