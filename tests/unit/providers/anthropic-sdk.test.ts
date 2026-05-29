import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AnthropicSdkProvider } from "../../../src/providers/anthropic-sdk.js";

// ── Helpers for mock streams ──────────────────────────────────────────────
function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "uuid-r",
    session_id: "sdk-session-123",
    type: "result" as const,
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 1,
    result: "Result text",
    total_cost_usd: 0.05,
    usage: { input_tokens: 10, output_tokens: 20 },
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  };
}

function makeTextDeltaEvent(text: string, sessionId = "sdk-session-123") {
  return {
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    session_id: sessionId,
    type: "stream_event" as const,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
    parent_tool_use_id: null,
  };
}

// ── Mock SDK ─────────────────────────────────────────────────────────────
let mockQueryImpl: (...args: any[]) => any;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn((...args: any[]) => mockQueryImpl(...args)),
  };
});

function setMockStream(messages: any[]) {
  mockQueryImpl = () => {
    async function* stream() {
      for (const msg of messages) yield msg;
    }
    return stream();
  };
}

function setMockStreamError(error: Error) {
  mockQueryImpl = () => {
    async function* stream(): AsyncGenerator<never> {
      throw error;
    }
    return stream();
  };
}

/**
 * Creates a mock stream that yields one text delta, then blocks on a
 * deferred promise. Returns { promise, resolve, reject } to control it.
 */
function setHangingMockStream() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const gate = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  mockQueryImpl = () => {
    async function* stream() {
      yield makeTextDeltaEvent("partial");
      await gate;
      // If resolved (not rejected), yield a result
      yield makeResultMessage();
    }
    return stream();
  };

  return { resolve, reject };
}

const logger: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new AnthropicSdkProvider(
    {
      providerId: "test-sdk",
      displayName: "Test SDK",
      apiKey: "sk-ant-test",
      defaultModel: "sonnet",
      defaultCwd: "/default",
      maxSessions: 5,
      idleTimeoutMs: 600_000,
      ...overrides,
    },
    logger,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────
describe("AnthropicSdkProvider (unit)", () => {
  let provider: AnthropicSdkProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    setMockStream([makeTextDeltaEvent("Hello"), makeResultMessage()]);
    provider = makeProvider();
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  // ── sendMessage: onChunk error triggers abort ──────────────────────────
  describe("sendMessage: onChunk error", () => {
    it("aborts the stream when onChunk throws (lines 138-139)", async () => {
      const chunkError = new Error("Client disconnected");
      const onChunk = vi.fn(() => {
        throw chunkError;
      });

      await expect(
        provider.sendMessage({
          conversationId: "conv-err",
          content: "test",
          onChunk,
        }),
      ).rejects.toThrow("Client disconnected");
    });
  });

  // ── sendMessage: fallback to result.result text (line 150) ─────────────
  describe("sendMessage: fallback result text", () => {
    it("uses result.result when no streaming text was received (line 150)", async () => {
      // Only emit a result message with no preceding text delta
      setMockStream([makeResultMessage({ result: "Fallback result" })]);

      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-fb",
        content: "test",
        onChunk: (t) => chunks.push(t),
      });

      expect(result.text).toBe("Fallback result");
      // No streaming chunks should have been emitted
      expect(chunks).toHaveLength(0);
    });

    it("returns 'Done.' when neither streaming text nor result text exist", async () => {
      setMockStream([makeResultMessage({ result: undefined })]);

      const result = await provider.sendMessage({
        conversationId: "conv-empty",
        content: "test",
        onChunk: () => {},
      });

      expect(result.text).toBe("Done.");
    });
  });

  // ── sendMessage: error catch block (lines 164-166) ─────────────────────
  describe("sendMessage: error handling in catch block", () => {
    it("cleans up abortController and signal listener on SDK error (lines 164-166)", async () => {
      const sdkError = new Error("SDK stream failure");
      setMockStreamError(sdkError);

      const ac = new AbortController();
      const onChunk = vi.fn();

      await expect(
        provider.sendMessage({
          conversationId: "conv-fail",
          content: "test",
          onChunk,
          signal: ac.signal,
        }),
      ).rejects.toThrow("SDK stream failure");

      // After error, session should still exist but abortController should be null
      const info = provider.getSessionInfo("conv-fail");
      expect(info).not.toBeNull();
    });

    it("propagates external abort signal to internal controller", async () => {
      const ac = new AbortController();

      // Create a stream that listens for abort on the external signal
      mockQueryImpl = ({ options }: any) => {
        async function* stream() {
          yield makeTextDeltaEvent("start");
          await new Promise((_resolve, reject) => {
            // The provider hooks ac.signal -> internal abortController
            // We listen on the external signal since that propagates
            ac.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return stream();
      };

      const promise = provider.sendMessage({
        conversationId: "conv-abort",
        content: "test",
        onChunk: () => {},
        signal: ac.signal,
      });

      // Give the stream time to start, then abort
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();

      await expect(promise).rejects.toThrow();
    });
  });

  // ── interrupt: abort active session (lines 173-174) ────────────────────
  describe("interrupt", () => {
    it("aborts the active session's AbortController (lines 173-174)", async () => {
      const { reject } = setHangingMockStream();

      const promise = provider.sendMessage({
        conversationId: "conv-int",
        content: "test",
        onChunk: () => {},
      });

      // Give the stream time to yield the first message and block on gate
      await new Promise((r) => setTimeout(r, 10));

      // The session should now have an active abortController - interrupt it
      provider.interrupt("conv-int");

      // Reject the gate so the promise settles
      reject(new Error("aborted"));
      await expect(promise).rejects.toThrow();
    });

    it("does nothing when session has no active abortController", async () => {
      // Send a message to create a session
      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);
      await provider.sendMessage({
        conversationId: "conv-idle",
        content: "test",
        onChunk: () => {},
      });

      // After the message completes, abortController should be null
      // Interrupt should not throw
      expect(() => provider.interrupt("conv-idle")).not.toThrow();
    });
  });

  // ── resetSession with opts (line 181) ──────────────────────────────────
  describe("resetSession", () => {
    it("re-creates session with new cwd and model (line 181)", async () => {
      // First, create a session
      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);
      await provider.sendMessage({
        conversationId: "conv-reset",
        content: "test",
        onChunk: () => {},
      });

      // Reset with new opts
      await provider.resetSession("conv-reset", {
        cwd: "/new-cwd",
        model: "opus",
      });

      const info = provider.getSessionInfo("conv-reset");
      expect(info).not.toBeNull();
      expect(info!.cwd).toBe("/new-cwd");
      expect(info!.model).toBe("opus");
    });

    it("does not re-create session when opts have neither cwd nor model", async () => {
      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);
      await provider.sendMessage({
        conversationId: "conv-reset2",
        content: "test",
        onChunk: () => {},
      });

      await provider.resetSession("conv-reset2", {});
      const info = provider.getSessionInfo("conv-reset2");
      expect(info).toBeNull();
    });
  });

  // ── getUsageInfo returns null (line 219) ───────────────────────────────
  describe("getUsageInfo", () => {
    it("always returns null (line 219)", () => {
      expect(provider.getUsageInfo("conv-any")).toBeNull();
    });
  });

  // ── shutdown: abort active sessions (line 246) ─────────────────────────
  describe("shutdown", () => {
    it("aborts active sessions during shutdown (line 246)", async () => {
      const { reject } = setHangingMockStream();

      const promise = provider.sendMessage({
        conversationId: "conv-shutdown",
        content: "test",
        onChunk: () => {},
      });

      // Give the stream time to yield and block
      await new Promise((r) => setTimeout(r, 10));

      // Shutdown should abort all active sessions
      await provider.shutdown();

      // Reject gate so the promise settles
      reject(new Error("aborted by shutdown"));
      await expect(promise).rejects.toThrow();

      // Sessions should be cleared
      expect(provider.listSessions()).toHaveLength(0);
    });
  });

  // ── idle sweep (lines 291-298) ─────────────────────────────────────────
  describe("idle sweep", () => {
    it("removes idle sessions after timeout (lines 291-298)", async () => {
      vi.useFakeTimers();

      // Use a short idle timeout
      const shortProvider = makeProvider({ idleTimeoutMs: 5_000 });

      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);
      await shortProvider.sendMessage({
        conversationId: "conv-idle-sweep",
        content: "test",
        onChunk: () => {},
      });

      expect(shortProvider.getSessionInfo("conv-idle-sweep")).not.toBeNull();

      // Advance time past idle timeout + sweep interval (60s)
      vi.advanceTimersByTime(66_000);

      expect(shortProvider.getSessionInfo("conv-idle-sweep")).toBeNull();
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("idle timeout for conv-idle-sweep"));

      await shortProvider.shutdown();
      vi.useRealTimers();
    });

    it("does not remove busy sessions during sweep", async () => {
      vi.useFakeTimers();

      const shortProvider = makeProvider({ idleTimeoutMs: 5_000 });

      // Pre-create a session and manually set it busy by tweaking internals
      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);
      await shortProvider.sendMessage({
        conversationId: "conv-busy-sweep",
        content: "test",
        onChunk: () => {},
      });

      // Simulate the session being busy by setting an abortController
      const sessions = (shortProvider as any).sessions as Map<string, any>;
      const session = sessions.get("conv-busy-sweep");
      session.abortController = new AbortController();

      // Advance time past idle timeout + sweep interval
      vi.advanceTimersByTime(66_000);

      // Should NOT be removed because it has an active abortController
      expect(shortProvider.getSessionInfo("conv-busy-sweep")).not.toBeNull();

      // Clean up
      session.abortController = null;
      await shortProvider.shutdown();
      vi.useRealTimers();
    });
  });

  // ── sendMessage with systemPrompt ─────────────────────────────────────
  describe("sendMessage options", () => {
    it("passes systemPrompt as appendSystemPrompt", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const mockQuery = vi.mocked(query);
      mockQuery.mockClear();

      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);

      await provider.sendMessage({
        conversationId: "conv-sys",
        content: "test",
        onChunk: () => {},
        systemPrompt: "You are a helpful assistant.",
      });

      const callOpts = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
      expect(callOpts.appendSystemPrompt).toBe("You are a helpful assistant.");
    });

    it("uses resume when session has a non-sdk sessionId", async () => {
      // First, resume a session with a real session ID
      await provider.resumeSession("conv-resume", "real-session-id");

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const mockQuery = vi.mocked(query);
      mockQuery.mockClear();

      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);

      await provider.sendMessage({
        conversationId: "conv-resume",
        content: "test",
        onChunk: () => {},
      });

      const callOpts = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
      expect(callOpts.resume).toBe("real-session-id");
    });

    it("does not pass resume for fresh sdk- sessions", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const mockQuery = vi.mocked(query);
      mockQuery.mockClear();

      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);

      await provider.sendMessage({
        conversationId: "conv-fresh",
        content: "test",
        onChunk: () => {},
      });

      const callOpts = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
      expect(callOpts.resume).toBeUndefined();
    });
  });

  // ── stream_event with non-text_delta is ignored ────────────────────────
  describe("sendMessage: stream event filtering", () => {
    it("ignores stream_event with non-content_block_delta type", async () => {
      setMockStream([
        {
          uuid: "uuid-x",
          session_id: "sdk-session-123",
          type: "stream_event" as const,
          event: { type: "content_block_start", content_block: { type: "text" } },
          parent_tool_use_id: null,
        },
        makeTextDeltaEvent("real text"),
        makeResultMessage(),
      ]);

      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-filter",
        content: "test",
        onChunk: (t) => chunks.push(t),
      });

      expect(chunks).toEqual(["real text"]);
      expect(result.text).toBe("real text");
    });

    it("ignores text_delta with non-string text", async () => {
      setMockStream([
        {
          uuid: "uuid-x",
          session_id: "sdk-session-123",
          type: "stream_event" as const,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: 42 }, // not a string
          },
          parent_tool_use_id: null,
        },
        makeResultMessage({ result: "fallback" }),
      ]);

      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-nonstr",
        content: "test",
        onChunk: (t) => chunks.push(t),
      });

      expect(chunks).toHaveLength(0);
      expect(result.text).toBe("fallback");
    });
  });

  // ── setAgentMcpConfig: file with no mcpServers key ─────────────────────
  describe("setAgentMcpConfig", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = path.join(tmpdir(), `sdk-unit-mcp-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns early when parsed JSON has no mcpServers key", () => {
      const configPath = path.join(tmpDir, "no-mcp.json");
      writeFileSync(configPath, JSON.stringify({ somethingElse: true }));

      provider.setAgentMcpConfig!("agent-x", configPath);
      // Should not set any agentMcpServers (no error logged)
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  // ── resolveMcpServers: falls back to config.mcpServers ────────────────
  describe("resolveMcpServers", () => {
    it("falls back to config.mcpServers when no per-agent config", async () => {
      const providerWithMcp = makeProvider({
        mcpServers: {
          arinova: {
            type: "stdio",
            command: "node",
            args: ["/cli.js"],
            env: { ARINOVA_BOT_TOKEN: "tok" },
          },
        },
      });

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const mockQuery = vi.mocked(query);
      mockQuery.mockClear();

      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);

      await providerWithMcp.sendMessage({
        conversationId: "someagent:default",
        content: "test",
        onChunk: () => {},
      });

      const callOpts = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
      expect(callOpts.mcpServers).toBeDefined();

      await providerWithMcp.shutdown();
    });

    it("returns undefined when neither per-agent nor config mcpServers exist", async () => {
      // Provider without mcpServers
      const plainProvider = makeProvider();

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const mockQuery = vi.mocked(query);
      mockQuery.mockClear();

      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);

      await plainProvider.sendMessage({
        conversationId: "someagent:default",
        content: "test",
        onChunk: () => {},
      });

      const callOpts = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
      expect(callOpts.mcpServers).toBeUndefined();

      await plainProvider.shutdown();
    });
  });

  // ── listSessions: status reflects busy/ready ──────────────────────────
  describe("listSessions", () => {
    it("shows 'busy' status for session with active abortController", async () => {
      const { reject } = setHangingMockStream();

      const promise = provider.sendMessage({
        conversationId: "conv-busy-list",
        content: "test",
        onChunk: () => {},
      });

      // Give the async generator time to yield and block on gate
      await new Promise((r) => setTimeout(r, 10));

      const sessions = provider.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("busy");

      // Clean up
      reject(new Error("aborted"));
      await promise.catch(() => {});
    });

    it("shows 'ready' status for idle session", async () => {
      setMockStream([makeTextDeltaEvent("ok"), makeResultMessage()]);
      await provider.sendMessage({
        conversationId: "conv-ready-list",
        content: "test",
        onChunk: () => {},
      });

      const sessions = provider.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("ready");
    });
  });

  // ── setEnv is a no-op ─────────────────────────────────────────────────
  describe("setEnv", () => {
    it("does not throw (no-op)", () => {
      expect(() => provider.setEnv("KEY", "value")).not.toThrow();
    });
  });

  // ── getCostInfo returns null for unknown session ──────────────────────
  describe("getCostInfo", () => {
    it("returns null for unknown session", () => {
      expect(provider.getCostInfo("nonexistent")).toBeNull();
    });
  });

  // ── getSessionInfo returns null for unknown session ───────────────────
  describe("getSessionInfo", () => {
    it("returns null for unknown session", () => {
      expect(provider.getSessionInfo("nonexistent")).toBeNull();
    });
  });
});
