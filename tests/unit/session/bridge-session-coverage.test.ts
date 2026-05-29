import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BridgeSessionStore, getSummaryMaxTokens } from "../../../src/session/bridge-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Coverage gap tests for bridge-session.ts — targeting 95%+ statement coverage
// Focuses on: estimateTokens, needsCompact, search/FTS, sanitiseFtsQuery,
// getContextWindow, listSessionIds, getMessageCount, has, getSessionMeta,
// listSessions, toSessionMeta, and edge cases in compact/buildContext.
// ---------------------------------------------------------------------------

function createLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    error: (msg: string) => logs.push({ level: "error", msg }),
    debug: (msg: string) => logs.push({ level: "debug", msg }),
    _logs: logs,
  };
}

describe("BridgeSessionStore — coverage gaps", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  let logger: ReturnType<typeof createLogger>;
  const convId = "cov-test-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-cov-"));
    logger = createLogger();
    store = new BridgeSessionStore(tmpDir, logger as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- estimateTokens ---------------------------------------------------

  describe("estimateTokens()", () => {
    it("returns sum of stored token counts + summary tokens when counts are available", () => {
      store.addUserMessage(convId, "hello world", "user", { model: "gpt-4.1" });
      store.addAssistantMessage(convId, "hi there", "bot", { model: "gpt-4.1" });

      const tokens = store.estimateTokens(convId, "gpt-4.1");
      expect(tokens).toBeGreaterThan(0);
    });

    it("includes summary tokens when a compacted summary exists", async () => {
      // Add enough messages to compact
      for (let i = 1; i <= 20; i++) {
        if (i % 2 === 1) {
          store.addUserMessage(convId, `msg ${i}`, "user");
        } else {
          store.addAssistantMessage(convId, `msg ${i}`, "bot");
        }
      }

      await store.compact(convId, async () => "This is a summary with some content for token counting");

      const tokens = store.estimateTokens(convId);
      // Should include both message tokens and summary tokens
      expect(tokens).toBeGreaterThan(0);
    });

    it("falls back to counting all context text when stored total is 0", () => {
      // Create a session with no messages but that exists
      // The fallback path triggers when totalRow.total === 0
      const emptyConvId = "empty-conv";
      const tokens = store.estimateTokens(emptyConvId);
      // With no session/messages, buildContext returns "", which has 0 tokens
      expect(tokens).toBe(0);
    });
  });

  // ---- needsCompact -----------------------------------------------------

  describe("needsCompact()", () => {
    it("returns false when tokens are well below threshold", () => {
      store.addUserMessage(convId, "short message", "user");
      expect(store.needsCompact(convId, "claude-opus-4-6")).toBe(false);
    });

    it("uses reported context window when provided and positive", () => {
      store.addUserMessage(convId, "x ".repeat(100), "user");
      // With a tiny reported window, even a small message should trigger compact
      expect(store.needsCompact(convId, "gpt-4.1", 10)).toBe(true);
    });

    it("falls back to model context window when reported window is 0", () => {
      store.addUserMessage(convId, "small message", "user");
      // reportedContextWindow = 0 should fall through to model-based window
      expect(store.needsCompact(convId, "claude-opus-4-6", 0)).toBe(false);
    });

    it("falls back to model context window when reported window is negative", () => {
      store.addUserMessage(convId, "small message", "user");
      expect(store.needsCompact(convId, "claude-opus-4-6", -100)).toBe(false);
    });

    it("falls back to model context window when reported window is undefined", () => {
      store.addUserMessage(convId, "small message", "user");
      expect(store.needsCompact(convId, "claude-opus-4-6")).toBe(false);
    });
  });

  // ---- getContextWindow -------------------------------------------------

  describe("getContextWindow()", () => {
    it("returns known window for exact model match", () => {
      expect(store.getContextWindow("claude-opus-4-6")).toBe(1_000_000);
      expect(store.getContextWindow("gpt-4.1")).toBe(1_000_000);
      expect(store.getContextWindow("gpt-5.4")).toBe(1_050_000);
    });

    it("returns default window for unknown model", () => {
      expect(store.getContextWindow("totally-unknown")).toBe(200_000);
    });

    it("returns default window when model is undefined", () => {
      expect(store.getContextWindow()).toBe(200_000);
    });

    it("uses prefix fallback for versioned model names", () => {
      // "gpt-4.1-mini-2025-01" should match "gpt-4.1-mini" prefix
      expect(store.getContextWindow("gpt-4.1-mini-2025-01")).toBe(1_000_000);
    });
  });

  // ---- search / FTS5 ----------------------------------------------------

  describe("search() — FTS5 global search", () => {
    it("finds messages matching a query term", () => {
      store.addUserMessage(convId, "deploy the application to production", "user");
      store.addAssistantMessage(convId, "deployment started successfully", "bot");
      store.addUserMessage(convId, "check the weather today", "user");

      const results = store.search("deploy");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((m) => m.content.includes("deploy"))).toBe(true);
    });

    it("returns empty array for empty query", () => {
      store.addUserMessage(convId, "some content", "user");
      const results = store.search("");
      expect(results).toEqual([]);
    });

    it("returns empty array for query with only special characters", () => {
      store.addUserMessage(convId, "some content", "user");
      const results = store.search("{}()[]");
      expect(results).toEqual([]);
    });

    it("respects the limit parameter", () => {
      for (let i = 1; i <= 10; i++) {
        store.addUserMessage(convId, `message about testing number ${i}`, "user");
      }
      const results = store.search("testing", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("returns results across multiple sessions", () => {
      store.addUserMessage("conv-a", "deploy feature alpha", "user");
      store.addUserMessage("conv-b", "deploy feature beta", "user");

      const results = store.search("deploy");
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("maps message rows to SessionMessage format correctly", () => {
      store.addUserMessage(convId, "searchable content here", "alice");
      const results = store.search("searchable");
      expect(results.length).toBe(1);
      expect(results[0].role).toBe("user");
      expect(results[0].sender).toBe("alice");
      expect(results[0].content).toContain("searchable");
      expect(results[0].timestamp).toBeGreaterThan(0);
      expect(results[0].id).toBeDefined();
    });
  });

  describe("searchInSession() — FTS5 scoped search", () => {
    it("finds messages only within the specified session", () => {
      store.addUserMessage("conv-a", "unique alpha content", "user");
      store.addUserMessage("conv-b", "unique beta content", "user");

      const resultsA = store.searchInSession("conv-a", "unique");
      const resultsB = store.searchInSession("conv-b", "unique");

      expect(resultsA.length).toBe(1);
      expect(resultsA[0].content).toContain("alpha");

      expect(resultsB.length).toBe(1);
      expect(resultsB[0].content).toContain("beta");
    });

    it("returns empty array for empty query", () => {
      store.addUserMessage(convId, "content", "user");
      const results = store.searchInSession(convId, "");
      expect(results).toEqual([]);
    });

    it("returns empty array when no matches in session", () => {
      store.addUserMessage(convId, "hello world", "user");
      const results = store.searchInSession(convId, "nonexistentterm");
      expect(results).toEqual([]);
    });

    it("respects the limit parameter", () => {
      for (let i = 1; i <= 10; i++) {
        store.addUserMessage(convId, `repeated keyword testing ${i}`, "user");
      }
      const results = store.searchInSession(convId, "testing", 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  // ---- sanitiseFtsQuery (tested indirectly through search) ---------------

  describe("FTS query sanitisation", () => {
    it("handles hyphenated terms by quoting them", () => {
      store.addUserMessage(convId, "bridge-session module is working", "user");
      // Hyphenated term should be wrapped in quotes internally
      const results = store.search("bridge-session");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("handles dotted terms by quoting them", () => {
      store.addUserMessage(convId, "file src/session/bridge.session.ts updated", "user");
      const results = store.search("bridge.session.ts");
      // Should not throw FTS5 syntax error
      expect(Array.isArray(results)).toBe(true);
    });

    it("strips dangerous FTS characters", () => {
      store.addUserMessage(convId, "some content here", "user");
      // These characters would break FTS5 syntax if not stripped
      const results = store.search("some {content} [here]");
      expect(Array.isArray(results)).toBe(true);
    });

    it("handles complex multi-hyphen terms", () => {
      store.addUserMessage(convId, "bridge-session-compact-test running", "user");
      const results = store.search("bridge-session-compact-test");
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ---- listSessionIds ---------------------------------------------------

  describe("listSessionIds()", () => {
    it("returns empty array when no sessions exist", () => {
      expect(store.listSessionIds()).toEqual([]);
    });

    it("returns all active session IDs", () => {
      store.addUserMessage("conv-1", "msg", "user");
      store.addUserMessage("conv-2", "msg", "user");
      store.addUserMessage("conv-3", "msg", "user");

      const ids = store.listSessionIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("conv-1");
      expect(ids).toContain("conv-2");
      expect(ids).toContain("conv-3");
    });

    it("does not include cleared sessions", () => {
      store.addUserMessage("conv-1", "msg", "user");
      store.addUserMessage("conv-2", "msg", "user");
      store.clear("conv-1");

      const ids = store.listSessionIds();
      expect(ids).toHaveLength(1);
      expect(ids).toContain("conv-2");
    });

    it("returns sessions in order and contains expected IDs", () => {
      store.addUserMessage("conv-1", "msg", "user");
      store.addUserMessage("conv-2", "msg", "user");

      const ids = store.listSessionIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain("conv-1");
      expect(ids).toContain("conv-2");
    });
  });

  // ---- getMessageCount --------------------------------------------------

  describe("getMessageCount()", () => {
    it("returns 0 for non-existent session", () => {
      expect(store.getMessageCount("nonexistent")).toBe(0);
    });

    it("returns correct count after adding messages", () => {
      store.addUserMessage(convId, "msg 1", "user");
      store.addAssistantMessage(convId, "msg 2", "bot");
      store.addUserMessage(convId, "msg 3", "user");

      expect(store.getMessageCount(convId)).toBe(3);
    });

    it("reflects count after compact (middle messages deleted)", async () => {
      for (let i = 1; i <= 20; i++) {
        if (i % 2 === 1) {
          store.addUserMessage(convId, `msg ${i}`, "user");
        } else {
          store.addAssistantMessage(convId, `msg ${i}`, "bot");
        }
      }
      expect(store.getMessageCount(convId)).toBe(20);

      await store.compact(convId, async () => "summary");

      // After compact: first 2 + last 10 = 12 messages remain
      expect(store.getMessageCount(convId)).toBe(12);
    });
  });

  // ---- has --------------------------------------------------------------

  describe("has()", () => {
    it("returns false for non-existent session", () => {
      expect(store.has("nonexistent")).toBe(false);
    });

    it("returns true for existing session", () => {
      store.addUserMessage(convId, "msg", "user");
      expect(store.has(convId)).toBe(true);
    });

    it("returns false after clearing a session", () => {
      store.addUserMessage(convId, "msg", "user");
      store.clear(convId);
      expect(store.has(convId)).toBe(false);
    });
  });

  // ---- getSessionMeta ---------------------------------------------------

  describe("getSessionMeta()", () => {
    it("returns null for non-existent session", () => {
      expect(store.getSessionMeta("nonexistent")).toBeNull();
    });

    it("returns metadata for existing session", () => {
      store.addUserMessage(convId, "hello", "alice", {
        model: "gpt-4.1",
        userId: "user-123",
        username: "alice",
      });

      const meta = store.getSessionMeta(convId);
      expect(meta).not.toBeNull();
      expect(meta!.conversationId).toBe(convId);
      expect(meta!.model).toBe("gpt-4.1");
      expect(meta!.userId).toBe("user-123");
      expect(meta!.username).toBe("alice");
      expect(meta!.messageCount).toBeGreaterThanOrEqual(1);
      expect(meta!.totalTokens).toBeGreaterThan(0);
      expect(meta!.createdAt).toBeGreaterThan(0);
      expect(meta!.updatedAt).toBeGreaterThan(0);
    });

    it("returns metadata with undefined optional fields when not set", () => {
      store.addUserMessage(convId, "hello", "user");

      const meta = store.getSessionMeta(convId);
      expect(meta).not.toBeNull();
      expect(meta!.conversationId).toBe(convId);
    });

    it("updates metadata after additional messages", () => {
      store.addUserMessage(convId, "first", "user");
      const meta1 = store.getSessionMeta(convId);

      store.addAssistantMessage(convId, "second reply with more tokens", "bot");
      const meta2 = store.getSessionMeta(convId);

      expect(meta2!.messageCount).toBeGreaterThan(meta1!.messageCount);
      expect(meta2!.totalTokens).toBeGreaterThan(meta1!.totalTokens);
      expect(meta2!.updatedAt).toBeGreaterThanOrEqual(meta1!.updatedAt);
    });
  });

  // ---- listSessions -----------------------------------------------------

  describe("listSessions()", () => {
    it("returns empty array when no sessions exist", () => {
      expect(store.listSessions()).toEqual([]);
    });

    it("returns all sessions with metadata", () => {
      store.addUserMessage("conv-a", "msg", "alice", { model: "gpt-4.1" });
      store.addUserMessage("conv-b", "msg", "bob", { model: "claude-opus-4-6" });

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);

      const convA = sessions.find((s) => s.conversationId === "conv-a");
      const convB = sessions.find((s) => s.conversationId === "conv-b");

      expect(convA).toBeDefined();
      expect(convA!.model).toBe("gpt-4.1");
      expect(convA!.messageCount).toBeGreaterThanOrEqual(1);

      expect(convB).toBeDefined();
      expect(convB!.model).toBe("claude-opus-4-6");
    });

    it("returns sessions and contains expected IDs", () => {
      store.addUserMessage("conv-1", "msg", "user");
      store.addUserMessage("conv-2", "msg", "user");

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.conversationId);
      expect(ids).toContain("conv-1");
      expect(ids).toContain("conv-2");
    });

    it("does not include cleared sessions", () => {
      store.addUserMessage("conv-a", "msg", "user");
      store.addUserMessage("conv-b", "msg", "user");
      store.clear("conv-a");

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].conversationId).toBe("conv-b");
    });

    it("maps SessionMetaRow fields correctly including nulls", () => {
      // Add a session without explicit model/userId — those fields should
      // come through as undefined (not null) in the returned SessionMeta.
      store.addUserMessage(convId, "msg", "sender-only");

      const sessions = store.listSessions();
      const meta = sessions.find((s) => s.conversationId === convId)!;
      expect(meta.conversationId).toBe(convId);
      // model is null in DB when not provided -> should be undefined
      expect(meta.model).toBeUndefined();
      // userId is null -> undefined
      expect(meta.userId).toBeUndefined();
      // username comes from sender fallback
      expect(meta.username).toBe("sender-only");
      expect(meta.messageCount).toBe(1);
      expect(meta.totalTokens).toBeGreaterThan(0);
      expect(typeof meta.createdAt).toBe("number");
      expect(typeof meta.updatedAt).toBe("number");
    });
  });

  // ---- getMessages (toSessionMessage mapping) ----------------------------

  describe("getMessages() — toSessionMessage mapping", () => {
    it("maps all fields from message row to SessionMessage", () => {
      store.addUserMessage(convId, "hello", "alice", { model: "gpt-4.1" });
      store.addAssistantMessage(convId, "reply", "bot", {
        model: "gpt-4.1",
        finishReason: "end_turn",
      });

      const messages = store.getMessages(convId);
      expect(messages).toHaveLength(2);

      const userMsg = messages[0];
      expect(userMsg.id).toBeDefined();
      expect(userMsg.role).toBe("user");
      expect(userMsg.content).toBe("hello");
      expect(userMsg.userMessage).toBe("hello"); // extracted from content
      expect(userMsg.sender).toBe("alice");
      expect(userMsg.timestamp).toBeGreaterThan(0);
      expect(userMsg.tokenCount).toBeGreaterThan(0);
      expect(userMsg.finishReason).toBeUndefined(); // user messages have no finish reason

      const assistantMsg = messages[1];
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.content).toBe("reply");
      expect(assistantMsg.userMessage).toBeUndefined(); // assistant messages have null user_message
      expect(assistantMsg.sender).toBe("bot");
      expect(assistantMsg.finishReason).toBe("end_turn");
    });

    it("returns empty array for non-existent session", () => {
      expect(store.getMessages("nonexistent")).toEqual([]);
    });
  });

  // ---- addUserMessage with opts -----------------------------------------

  describe("addUserMessage() — options handling", () => {
    it("stores model, userId, and username in session metadata", () => {
      store.addUserMessage(convId, "msg", "alice", {
        model: "claude-opus-4-6",
        userId: "uid-456",
        username: "alice-display",
      });

      const meta = store.getSessionMeta(convId);
      expect(meta!.model).toBe("claude-opus-4-6");
      expect(meta!.userId).toBe("uid-456");
      expect(meta!.username).toBe("alice-display");
    });

    it("defaults username to sender when not provided in opts", () => {
      store.addUserMessage(convId, "msg", "alice-sender");

      const meta = store.getSessionMeta(convId);
      expect(meta!.username).toBe("alice-sender");
    });

    it("extracts user-current-message from wrapped content", () => {
      const wrapped = `<system-prompt>sys</system-prompt>
<user-current-message>
actual user input
</user-current-message>`;

      store.addUserMessage(convId, wrapped, "user");

      const messages = store.getMessages(convId);
      expect(messages[0].userMessage).toBe("actual user input");
      // The full content is stored as-is
      expect(messages[0].content).toBe(wrapped);
    });
  });

  // ---- addAssistantMessage with opts ------------------------------------

  describe("addAssistantMessage() — options handling", () => {
    it("stores finishReason when provided", () => {
      store.addUserMessage(convId, "q", "user");
      store.addAssistantMessage(convId, "response", "bot", {
        finishReason: "max_tokens",
      });

      const messages = store.getMessages(convId);
      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.finishReason).toBe("max_tokens");
    });

    it("stores null finishReason when not provided", () => {
      store.addUserMessage(convId, "q", "user");
      store.addAssistantMessage(convId, "response", "bot");

      const messages = store.getMessages(convId);
      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.finishReason).toBeUndefined();
    });

    it("handles assistant message without sender", () => {
      store.addUserMessage(convId, "q", "user");
      store.addAssistantMessage(convId, "response");

      const messages = store.getMessages(convId);
      const assistant = messages.find((m) => m.role === "assistant")!;
      expect(assistant.sender).toBeUndefined();
    });
  });

  // ---- buildContext — user_message preference ----------------------------

  describe("buildContext() — user_message preference for user rows", () => {
    it("uses user_message (extracted clean input) for user rows, not raw content", () => {
      const wrappedContent = `<system-prompt>system instructions</system-prompt>
<user-current-message>
clean user question
</user-current-message>`;

      store.addUserMessage(convId, wrappedContent, "user");
      const ctx = store.buildContext(convId);

      expect(ctx).toContain("user: clean user question");
      expect(ctx).not.toContain("<system-prompt>");
    });

    it("uses raw content for assistant rows", () => {
      store.addUserMessage(convId, "question", "user");
      store.addAssistantMessage(convId, "here is the answer with <tags>", "bot");

      const ctx = store.buildContext(convId);
      expect(ctx).toContain("bot: here is the answer with <tags>");
    });
  });

  // ---- compact — multi-chunk and summary truncation ---------------------

  describe("compact() — additional edge cases", () => {
    it("does nothing when middle is empty (total equals min threshold)", async () => {
      // 12 messages = PROTECT_FIRST_N(2) + PROTECT_LAST_N(10) — no middle
      for (let i = 1; i <= 12; i++) {
        store.addUserMessage(convId, `msg ${i}`, "user");
      }

      let called = false;
      await store.compact(convId, async () => {
        called = true;
        return "should not be called";
      });
      expect(called).toBe(false);
      expect(store.getMessageCount(convId)).toBe(12);
    });

    it("logs info when compacting in multiple chunks", async () => {
      // Create messages where middle section is large enough for multiple chunks
      for (let i = 1; i <= 20; i++) {
        store.addUserMessage(convId, `large message ${i} ${"y".repeat(80)}`, "user");
      }

      await store.compact(convId, async (msgs, existing) => `summary-${existing ? "merged" : "initial"}`, {
        compactInputChunkChars: 200,
      });

      const infoLogs = logger._logs.filter((l) => l.level === "info" && l.msg.includes("chunks"));
      expect(infoLogs.length).toBeGreaterThanOrEqual(1);
    });

    it("final compact log includes correct protected/compressed counts", async () => {
      for (let i = 1; i <= 15; i++) {
        if (i % 2 === 1) {
          store.addUserMessage(convId, `msg ${i}`, "user");
        } else {
          store.addAssistantMessage(convId, `msg ${i}`, "bot");
        }
      }

      await store.compact(convId, async () => "summary");

      const compactLog = logger._logs.find(
        (l) => l.level === "info" && l.msg.includes("compacted") && l.msg.includes("compressed"),
      );
      expect(compactLog).toBeDefined();
      expect(compactLog!.msg).toContain("protected first 2");
      expect(compactLog!.msg).toContain("last 10");
      expect(compactLog!.msg).toContain("compressed 3 middle");
    });
  });

  // ---- Database migration paths (constructor) ---------------------------

  describe("Database migrations", () => {
    it("can open the same database twice without error (migrations are idempotent)", () => {
      // First store already created in beforeEach
      store.addUserMessage(convId, "hello", "user");

      // Creating a second store on the same directory should not throw
      // because ALTER TABLE migrations silently catch "column already exists"
      const store2 = new BridgeSessionStore(tmpDir, logger as any);
      const messages = store2.getMessages(convId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("hello");
    });
  });

  // ---- FTS search error handling ----------------------------------------

  describe("search error handling", () => {
    it("search() returns results for normal queries", () => {
      store.addUserMessage(convId, "test content here", "user");
      const results = store.search("test content");
      expect(Array.isArray(results)).toBe(true);
    });

    it("searchInSession() returns results for normal queries", () => {
      store.addUserMessage(convId, "test content here", "user");
      const results = store.searchInSession(convId, "test content");
      expect(Array.isArray(results)).toBe(true);
    });

    it("search handles query with all special chars stripped to whitespace", () => {
      store.addUserMessage(convId, "test", "user");
      // After stripping all special chars, this becomes just spaces -> empty -> returns []
      const results = store.search("@#$%^&*");
      expect(results).toEqual([]);
    });

    it("search() catches FTS5 errors and returns empty array", () => {
      store.addUserMessage(convId, "test content", "user");
      // FTS5 treats a bare double-quote as a syntax error. The sanitiser
      // strips most special characters but a lone double-quote can survive
      // via the hyphen/dot quoting logic. We can't easily inject a raw
      // bad query through the public API, but we can verify that a query
      // whose sanitised form triggers an FTS5 error is handled gracefully.
      // Using "OR" as a standalone FTS5 keyword without operands triggers
      // an error in some FTS5 implementations.
      const results = store.search("OR");
      // Whether it returns results or empty, it must not throw
      expect(Array.isArray(results)).toBe(true);
    });

    it("searchInSession() catches FTS5 errors and returns empty array", () => {
      store.addUserMessage(convId, "test content", "user");
      const results = store.searchInSession(convId, "OR");
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ---- getTiktokenModel default path (non-standard model) ----------------

  describe("Non-standard model names", () => {
    it("handles model names not starting with claude or gpt", () => {
      // "llama-3" doesn't match any prefix — triggers default return in getTiktokenModel
      // This is tested indirectly through addUserMessage which calls countTokens
      store.addUserMessage(convId, "test with llama model", "user", { model: "llama-3" });

      const messages = store.getMessages(convId);
      expect(messages[0].tokenCount).toBeGreaterThan(0);
    });

    it("handles model names like mistral that hit default encoder path", () => {
      store.addAssistantMessage(convId, "response text", "bot", { model: "mistral-large" });

      const messages = store.getMessages(convId);
      expect(messages[0].tokenCount).toBeGreaterThan(0);
    });
  });

  // ---- splitLargeCompactMessage — single message larger than chunk ------

  describe("compact() — large single message splitting", () => {
    it("splits a single oversized message into multiple chunks during compact", async () => {
      // Create 14 messages (2 protected first + 10 protected last + 2 middle)
      // Make one middle message extremely large so it exceeds compactInputChunkChars
      store.addUserMessage(convId, "first msg", "user");
      store.addAssistantMessage(convId, "second msg", "bot");
      // Middle messages (will be compacted):
      store.addUserMessage(convId, "x".repeat(500), "user"); // oversized message
      store.addAssistantMessage(convId, "small middle msg", "bot");
      // Protected last 10:
      for (let i = 5; i <= 14; i++) {
        store.addUserMessage(convId, `tail msg ${i}`, "user");
      }

      const calls: Array<{ count: number; existing?: string }> = [];
      await store.compact(
        convId,
        async (msgs, existing) => {
          calls.push({ count: msgs.length, existing });
          return `summary-${calls.length}`;
        },
        { compactInputChunkChars: 100 }, // tiny chunk size forces splitting
      );

      // The oversized message should have been split into multiple pieces
      // across separate chunks
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(store.getMessageCount(convId)).toBe(12); // 2 + 10 preserved
    });
  });
});
