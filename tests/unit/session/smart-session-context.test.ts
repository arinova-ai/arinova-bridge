import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BridgeSessionStore } from "../../../src/session/bridge-session.js";
import { clearA2aContextInjected } from "../../../src/ipc/router.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Smart Session Context — lifecycle integration tests
//
// These tests simulate the index.ts / router.ts context injection logic
// using a real BridgeSessionStore (SQLite) to verify the full lifecycle:
//   first inject → skip subsequent → re-inject after reset → full cleanup
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

/**
 * Simulates the Chat path injection logic from index.ts:
 *   - First message: buildContext → inject → mark
 *   - Subsequent: skip injection
 */
function simulateChatMessage(
  store: BridgeSessionStore,
  sessionId: string,
  injectedSet: Set<string>,
  content: string,
  sender: string,
): { bridgeSessionContext: string | undefined } {
  const isFirst = !injectedSet.has(sessionId);
  const bridgeSessionContext = isFirst
    ? (store.buildContext(sessionId) || undefined)
    : undefined;

  store.addUserMessage(sessionId, content, sender);

  if (isFirst) injectedSet.add(sessionId);

  // Simulate assistant response
  store.addAssistantMessage(sessionId, `reply to: ${content}`, "bot");

  return { bridgeSessionContext };
}

/**
 * Simulates onSessionReset — called by /model, /compact.
 * Clears tracking flags only, preserves DB.
 */
function simulateSessionReset(
  sessionId: string,
  chatSet: Set<string>,
): void {
  chatSet.delete(sessionId);
  clearA2aContextInjected(sessionId);
}

/**
 * Simulates onSessionClear — called by /new.
 * Clears DB + tracking flags.
 */
function simulateSessionClear(
  store: BridgeSessionStore,
  sessionId: string,
  chatSet: Set<string>,
): void {
  store.clear(sessionId);
  chatSet.delete(sessionId);
  clearA2aContextInjected(sessionId);
}

describe("Smart Session Context — lifecycle", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  let chatInjected: Set<string>;
  const sessionId = "agent:default";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-ssc-life-"));
    store = new BridgeSessionStore(tmpDir, createLogger() as any);
    chatInjected = new Set<string>();
    clearA2aContextInjected(sessionId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. First injection + subsequent skip ──

  it("first message injects context, subsequent messages skip", () => {
    // Seed some history (simulating previous session that was persisted)
    store.addUserMessage(sessionId, "old msg 1", "alice");
    store.addAssistantMessage(sessionId, "old reply 1", "bot");

    // First message — should inject
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "hello", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();
    expect(r1.bridgeSessionContext).toContain("old msg 1");

    // Second message — should skip
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "follow up", "alice");
    expect(r2.bridgeSessionContext).toBeUndefined();

    // Third message — still skips
    const r3 = simulateChatMessage(store, sessionId, chatInjected, "another", "alice");
    expect(r3.bridgeSessionContext).toBeUndefined();
  });

  it("first message with empty DB injects undefined (empty context)", () => {
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "brand new session", "alice");
    // buildContext returns "" for empty DB → converted to undefined
    expect(r1.bridgeSessionContext).toBeUndefined();
  });

  // ── 2. /model → re-inject (DB preserved) ──

  it("/model resets tracking but preserves DB — next message re-injects with full context", () => {
    // Build up some conversation
    store.addUserMessage(sessionId, "discuss feature X", "alice");
    store.addAssistantMessage(sessionId, "sure, let me explain", "bot");

    // First message
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "go on", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();

    // Simulate /model → onSessionReset (DB NOT cleared, only tracking flags)
    simulateSessionReset(sessionId, chatInjected);

    // Next message after /model — should re-inject with full context (DB intact)
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "continue", "alice");
    expect(r2.bridgeSessionContext).toBeDefined();
    // DB is preserved, so all history is included
    expect(r2.bridgeSessionContext).toContain("discuss feature X");
    expect(r2.bridgeSessionContext).toContain("go on");
  });

  // ── 3. /compact → re-inject with summary (DB preserved) ──

  it("/compact resets tracking — next message re-injects updated context with summary", async () => {
    // Build up enough messages for compaction
    for (let i = 1; i <= 20; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(sessionId, `msg-${i}`, "alice");
      } else {
        store.addAssistantMessage(sessionId, `msg-${i}`, "bot");
      }
    }

    // First message (pre-compact)
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "pre-compact", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();

    // Compact
    await store.compact(sessionId, async () => "Summary: discussed feature X, commits abc123");

    // Simulate /compact → onSessionReset
    simulateSessionReset(sessionId, chatInjected);

    // Next message — should re-inject with updated summary
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "what was the commit?", "alice");
    expect(r2.bridgeSessionContext).toBeDefined();
    expect(r2.bridgeSessionContext).toContain("Summary: discussed feature X, commits abc123");
    expect(r2.bridgeSessionContext).toContain("[Conversation summary]");
  });

  // ── 4. /new → full cleanup (DB + flags) ──

  it("/new clears DB and tracking — next message gets empty context", async () => {
    // Build conversation + compact
    for (let i = 1; i <= 20; i++) {
      store.addUserMessage(sessionId, `msg-${i}`, "alice");
      store.addAssistantMessage(sessionId, `reply-${i}`, "bot");
    }
    await store.compact(sessionId, async () => "important summary");

    // First message
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "check", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();
    expect(r1.bridgeSessionContext).toContain("important summary");

    // Simulate /new → onSessionClear (DB + flags cleared)
    simulateSessionClear(store, sessionId, chatInjected);

    // Next message — should be empty context (undefined)
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "fresh start", "alice");
    expect(r2.bridgeSessionContext).toBeUndefined();
    // DB was wiped, so no history at all
    expect(store.buildContext(sessionId)).not.toContain("important summary");
  });

  // ── 5. Chat / A2A shared tracking set independence ──

  it("Chat and A2A have independent tracking — clearing one does not affect the other", () => {
    store.addUserMessage(sessionId, "setup", "alice");
    store.addAssistantMessage(sessionId, "ok", "bot");

    // Chat: first message → mark as injected
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "chat msg", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();

    // Clear A2A flag — should NOT affect Chat tracking
    clearA2aContextInjected(sessionId);

    // Chat: second message — should still skip (Chat flag is intact)
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "still chatting", "alice");
    expect(r2.bridgeSessionContext).toBeUndefined();
  });

  it("/model reset clears both Chat AND A2A flags", () => {
    store.addUserMessage(sessionId, "history", "alice");
    store.addAssistantMessage(sessionId, "reply", "bot");

    // Chat: first message
    simulateChatMessage(store, sessionId, chatInjected, "msg 1", "alice");
    expect(chatInjected.has(sessionId)).toBe(true);

    // /model reset — should clear Chat flag (A2A flag cleared via clearA2aContextInjected)
    simulateSessionReset(sessionId, chatInjected);

    expect(chatInjected.has(sessionId)).toBe(false);
  });

  // ── 6. buildContext LIMIT 20 ──

  it("buildContext returns at most 20 messages", () => {
    for (let i = 1; i <= 30; i++) {
      store.addUserMessage(sessionId, `m-${i}`, "alice");
    }

    const ctx = store.buildContext(sessionId);
    // First 10 should be trimmed (30 - 20 = 10)
    expect(ctx).not.toContain("m-1\n");
    expect(ctx).not.toContain("m-10\n");
    // Last 20 should be present
    expect(ctx).toContain("m-11");
    expect(ctx).toContain("m-30");
  });

  // ── 7. Compact failure → session unchanged, next message not re-injected ──

  it("compact failure does not clear tracking flag — subsequent messages still skip", async () => {
    store.addUserMessage(sessionId, "seed", "alice");
    store.addAssistantMessage(sessionId, "ok", "bot");

    // First message
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "msg", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();

    // Compact fails — tracking flag should NOT be cleared
    try {
      await store.compact(sessionId, async () => { throw new Error("API timeout"); });
    } catch {
      // expected
    }
    // Note: simulateSessionReset is NOT called on failure (handler returns early)

    // Next message — flag still set, so should skip
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "retry", "alice");
    expect(r2.bridgeSessionContext).toBeUndefined();
  });

  // ── 8. Multiple resets in sequence ──

  it("multiple /model resets: each clears flag, each next message re-injects", () => {
    store.addUserMessage(sessionId, "init", "alice");
    store.addAssistantMessage(sessionId, "ok", "bot");

    // 1st cycle
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "round 1", "alice");
    expect(r1.bridgeSessionContext).toBeDefined();

    simulateSessionReset(sessionId, chatInjected);

    // 2nd cycle — re-injects
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "round 2", "alice");
    expect(r2.bridgeSessionContext).toBeDefined();

    simulateSessionReset(sessionId, chatInjected);

    // 3rd cycle — re-injects again
    const r3 = simulateChatMessage(store, sessionId, chatInjected, "round 3", "alice");
    expect(r3.bridgeSessionContext).toBeDefined();
    // Should contain all history (DB never cleared)
    expect(r3.bridgeSessionContext).toContain("init");
    expect(r3.bridgeSessionContext).toContain("round 1");
    expect(r3.bridgeSessionContext).toContain("round 2");
  });

  // ── 9. /new then /model: independent lifecycle ──

  it("/new wipes everything, subsequent /model on fresh session works correctly", () => {
    // Build history
    store.addUserMessage(sessionId, "old history", "alice");
    store.addAssistantMessage(sessionId, "old reply", "bot");

    simulateChatMessage(store, sessionId, chatInjected, "msg", "alice");

    // /new — wipe everything
    simulateSessionClear(store, sessionId, chatInjected);

    // Start fresh conversation
    const r1 = simulateChatMessage(store, sessionId, chatInjected, "fresh start", "alice");
    expect(r1.bridgeSessionContext).toBeUndefined(); // empty DB → undefined

    // /model reset
    simulateSessionReset(sessionId, chatInjected);

    // Next message — re-injects, now has the "fresh start" message
    const r2 = simulateChatMessage(store, sessionId, chatInjected, "after model switch", "alice");
    expect(r2.bridgeSessionContext).toBeDefined();
    expect(r2.bridgeSessionContext).toContain("fresh start");
    expect(r2.bridgeSessionContext).not.toContain("old history"); // wiped by /new
  });
});
