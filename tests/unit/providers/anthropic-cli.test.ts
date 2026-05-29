import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicCliProvider, type AnthropicCliConfig } from "../../../src/providers/anthropic-cli.js";
import type { SendMessageOpts, WarmupOpts } from "../../../src/providers/types.js";

// ── Mock ClaudeProcess ──────────────────────────────────────────────────
// Returns a constructor function so `new ClaudeProcess(...)` produces a
// controllable fake.
const mockProcessInstances: any[] = [];

function makeMockProcess() {
  const proc: any = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    sendMessage: vi.fn(async (_text: string, onText?: (t: string) => void) => {
      onText?.("reply-chunk");
      return { text: "reply", sessionId: "sid-1", durationMs: 100, numTurns: 1 };
    }),
    isAlive: vi.fn(() => true),
    isBusy: vi.fn(() => false),
    abortTurn: vi.fn(),
    getSessionId: vi.fn(() => "sid-1"),
    getTotalCost: vi.fn(() => 0.05),
    getCwd: vi.fn(() => "/test"),
    getModel: vi.fn(() => "sonnet"),
    getContext: vi.fn(() => ({ contextTokens: 500, contextWindow: 200000 })),
    getRateLimits: vi.fn(() => new Map()),
    getWindowUsage: vi.fn(() => undefined),
    setReportToolCall: vi.fn(),
  };
  mockProcessInstances.push(proc);
  return proc;
}

vi.mock("../../../src/claude/session-store.js", () => {
  return {
    SessionStore: vi.fn(function (this: any) {
      // Maintain an internal map for realism
      this._sessions = new Map<string, any>();
      this._createCount = 0;

      this.setAgentMcpConfig = vi.fn();

      this.createSession = vi.fn((conversationId: string, _opts?: any) => {
        const proc = makeMockProcess();
        const entry = { process: proc, lastActivity: Date.now(), cwd: "/test" };
        this._sessions.set(conversationId, entry);
        this._createCount++;
        return entry;
      });

      this.getSession = vi.fn((conversationId: string) => {
        return this._sessions.get(conversationId);
      });

      this.destroySession = vi.fn(async (conversationId: string) => {
        this._sessions.delete(conversationId);
      });

      this.resumeSession = vi.fn(async (_conversationId: string, _sessionId?: string) => {
        const proc = makeMockProcess();
        const entry = { process: proc, lastActivity: Date.now(), cwd: "/test" };
        this._sessions.set(_conversationId, entry);
        return entry;
      });

      this.listSessions = vi.fn(() => []);

      this.stopAll = vi.fn(async () => {
        this._sessions.clear();
      });
    }),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────
const logger: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeConfig(overrides?: Partial<AnthropicCliConfig>): AnthropicCliConfig {
  return {
    providerId: "test-provider",
    displayName: "Test Anthropic CLI",
    claudePath: "/usr/bin/claude",
    defaultCwd: "/default",
    maxSessions: 5,
    idleTimeoutMs: 600_000,
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<SendMessageOpts>): SendMessageOpts {
  return {
    conversationId: "conv-1",
    content: "hello",
    onChunk: vi.fn(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────
describe("AnthropicCliProvider", () => {
  let provider: AnthropicCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessInstances.length = 0;
    provider = new AnthropicCliProvider(makeConfig(), logger);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  // ── Constructor ──────────────────────────────────────────────────────
  describe("constructor", () => {
    it("sets id, type, and displayName from config", () => {
      expect(provider.id).toBe("test-provider");
      expect(provider.type).toBe("anthropic-cli");
      expect(provider.displayName).toBe("Test Anthropic CLI");
    });

    it("defaults models to null when not provided", () => {
      expect(provider.supportedModels()).toBeNull();
    });

    it("returns models array when configured", () => {
      const p = new AnthropicCliProvider(makeConfig({ models: ["opus", "sonnet"] }), logger);
      expect(p.supportedModels()).toEqual(["opus", "sonnet"]);
    });
  });

  // ── setAgentMcpConfig ────────────────────────────────────────────────
  describe("setAgentMcpConfig", () => {
    it("delegates to the session store", () => {
      provider.setAgentMcpConfig("agent-1", "/path/to/mcp.json");
      const store = (provider as any).store;
      expect(store.setAgentMcpConfig).toHaveBeenCalledWith("agent-1", "/path/to/mcp.json");
    });
  });

  // ── warmup ───────────────────────────────────────────────────────────
  describe("warmup", () => {
    it("creates a new session when none exists", () => {
      const store = (provider as any).store;
      provider.warmup("conv-1", { cwd: "/work", model: "opus" });
      expect(store.createSession).toHaveBeenCalledWith("conv-1", {
        cwd: "/work",
        model: "opus",
        systemPrompt: undefined,
        reportToolCall: undefined,
      });
    });

    it("returns early when session exists and process is alive", () => {
      const store = (provider as any).store;
      // First call creates the session
      provider.warmup("conv-1");
      const firstCallCount = store.createSession.mock.calls.length;

      // Second call should skip creation
      provider.warmup("conv-1");
      expect(store.createSession).toHaveBeenCalledTimes(firstCallCount);
    });

    it("creates session when existing process is dead", () => {
      const store = (provider as any).store;
      provider.warmup("conv-1");
      const firstCallCount = store.createSession.mock.calls.length;

      // Make the existing process dead
      const entry = store.getSession("conv-1");
      entry.process.isAlive.mockReturnValue(false);

      provider.warmup("conv-1");
      expect(store.createSession).toHaveBeenCalledTimes(firstCallCount + 1);
    });

    it("sets reportToolCall on alive existing session", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");

      const reporter = vi.fn();
      provider.warmup("conv-1", { reportToolCall: reporter });
      expect(entry.process.setReportToolCall).toHaveBeenCalledWith(reporter);
    });

    it("passes all opts fields when creating session", () => {
      const store = (provider as any).store;
      const reporter = vi.fn();
      provider.warmup("conv-1", {
        cwd: "/work",
        model: "opus",
        systemPrompt: "You are a helpful assistant.",
        reportToolCall: reporter,
      });
      expect(store.createSession).toHaveBeenCalledWith("conv-1", {
        cwd: "/work",
        model: "opus",
        systemPrompt: "You are a helpful assistant.",
        reportToolCall: reporter,
      });
    });
  });

  // ── sendMessage (directSend) ─────────────────────────────────────────
  describe("sendMessage (direct)", () => {
    it("creates a session when none exists and sends the message", async () => {
      const store = (provider as any).store;
      const onChunk = vi.fn();
      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-1", content: "hi", onChunk }));

      expect(store.createSession).toHaveBeenCalled();
      expect(result.text).toBe("reply");
      expect(result.sessionId).toBe("sid-1");
      expect(result.durationMs).toBe(100);
      expect(result.numTurns).toBe(1);
    });

    it("reuses existing alive session", async () => {
      const store = (provider as any).store;
      // Pre-create
      provider.warmup("conv-1");
      const warmupCallCount = store.createSession.mock.calls.length;

      await provider.sendMessage(makeOpts({ conversationId: "conv-1" }));
      // Should NOT create a new session
      expect(store.createSession).toHaveBeenCalledTimes(warmupCallCount);
    });

    it("aborts in-flight turn on existing busy session", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.isBusy.mockReturnValue(true);

      await provider.sendMessage(makeOpts({ conversationId: "conv-1" }));
      expect(entry.process.abortTurn).toHaveBeenCalled();
    });

    it("creates new session when existing process is dead", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-1");
      const entry = store.getSession("conv-1");
      entry.process.isAlive.mockReturnValue(false);

      await provider.sendMessage(makeOpts({ conversationId: "conv-1" }));
      // createSession called once for warmup, once for directSend
      expect(store.createSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("sets reportToolCall on reused session", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      const reporter = vi.fn();

      await provider.sendMessage(makeOpts({ conversationId: "conv-1", reportToolCall: reporter }));
      expect(entry.process.setReportToolCall).toHaveBeenCalledWith(reporter);
    });

    it("streams chunks via onChunk callback", async () => {
      const onChunk = vi.fn();
      await provider.sendMessage(makeOpts({ conversationId: "conv-1", onChunk }));
      expect(onChunk).toHaveBeenCalledWith("reply-chunk");
    });

    it("passes signal and messageId to process.sendMessage", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      const ac = new AbortController();

      await provider.sendMessage(makeOpts({ conversationId: "conv-1", signal: ac.signal, messageId: "msg-42" }));

      const call = entry.process.sendMessage.mock.calls[0];
      expect(call[2]).toBe(ac.signal); // signal
      expect(call[3]).toBe("msg-42"); // messageId
    });

    // ── Error recovery: respawn on process-dead error ──────────────────
    it("respawns once on 'Claude process is not running' error", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-1");
      const entry = store.getSession("conv-1");

      // First call fails with process-dead error
      entry.process.sendMessage.mockRejectedValueOnce(new Error("Claude process is not running"));

      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-1" }));
      // createSession called: 1 for warmup + 1 for respawn
      expect(store.createSession.mock.calls.length).toBeGreaterThanOrEqual(2);
      // The respawned session's fresh mock process returns the default "reply"
      expect(result.text).toBe("reply");
    });

    it("respawns once on 'Claude process exited unexpectedly' error", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-1");
      const entry = store.getSession("conv-1");

      entry.process.sendMessage.mockRejectedValueOnce(new Error("Claude process exited unexpectedly"));

      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-1" }));
      expect(result.text).toBe("reply");
    });

    it("respawns once on 'Claude process error' error", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-1");
      const entry = store.getSession("conv-1");

      entry.process.sendMessage.mockRejectedValueOnce(new Error("Claude process error"));

      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-1" }));
      expect(result.text).toBe("reply");
    });

    it("does NOT retry when signal is already aborted", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");

      const ac = new AbortController();
      ac.abort();

      entry.process.sendMessage.mockRejectedValueOnce(new Error("Claude process is not running"));

      await expect(provider.sendMessage(makeOpts({ conversationId: "conv-1", signal: ac.signal }))).rejects.toThrow(
        "Claude process is not running",
      );
    });

    it("does NOT retry for non-process-dead errors", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");

      entry.process.sendMessage.mockRejectedValueOnce(new Error("Rate limit exceeded"));

      await expect(provider.sendMessage(makeOpts({ conversationId: "conv-1" }))).rejects.toThrow("Rate limit exceeded");
    });
  });

  // ── sendMessage (queuedSend) ─────────────────────────────────────────
  describe("sendMessage (queue)", () => {
    it("sends message in queue mode", async () => {
      const result = await provider.sendMessage(
        makeOpts({ conversationId: "conv-q", content: "queued msg", queue: true }),
      );
      expect(result.text).toBe("reply");
    });

    it("chains sequential queued sends for the same conversation", async () => {
      const order: number[] = [];
      const store = (provider as any).store;

      // Make the first send take a while
      let firstEntry: any;

      // Override createSession to track order
      const origCreate = store.createSession;
      store.createSession = vi.fn((...args: any[]) => {
        const entry = origCreate.call(store, ...args);
        if (!firstEntry) firstEntry = entry;
        return entry;
      });

      const p1 = provider.sendMessage(
        makeOpts({
          conversationId: "conv-q",
          content: "first",
          queue: true,
          onChunk: () => order.push(1),
        }),
      );

      const p2 = provider.sendMessage(
        makeOpts({
          conversationId: "conv-q",
          content: "second",
          queue: true,
          onChunk: () => order.push(2),
        }),
      );

      await Promise.all([p1, p2]);
      // Both should complete; order proves chaining
      expect(order).toEqual([1, 2]);
    });

    it("a failed queued send does not block subsequent sends", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-q");
      const entry = store.getSession("conv-q");

      // First queued send fails
      entry.process.sendMessage
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ text: "ok", sessionId: "sid-2", durationMs: 10, numTurns: 1 });

      const p1 = provider.sendMessage(makeOpts({ conversationId: "conv-q", queue: true })).catch(() => "failed");

      const p2 = provider.sendMessage(makeOpts({ conversationId: "conv-q", queue: true }));

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("failed");
      expect((r2 as any).text).toBe("ok");
    });

    it("creates a session when process is dead during idleSend", async () => {
      const store = (provider as any).store;
      // No session exists; idleSend will create one
      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-new", queue: true }));
      expect(store.createSession).toHaveBeenCalledWith("conv-new", expect.objectContaining({}));
      expect(result.text).toBe("reply");
    });

    it("waits for busy process before sending in queue mode", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-q");
      const entry = store.getSession("conv-q");

      // Process is busy for first check, then becomes idle
      let busyCount = 0;
      entry.process.isBusy.mockImplementation(() => {
        busyCount++;
        return busyCount <= 1;
      });

      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-q", queue: true }));
      expect(result.text).toBe("reply");
      expect(busyCount).toBeGreaterThanOrEqual(2);
    });

    it("recreates session if it dies while waiting for busy process", async () => {
      const store = (provider as any).store;
      provider.warmup("conv-q");
      const entry = store.getSession("conv-q");
      const initialCreateCount = store.createSession.mock.calls.length;

      // Process is busy, then dies
      let callCount = 0;
      entry.process.isBusy.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return true;
        return false;
      });

      // After first busy check, destroy the session so refresh finds it dead
      const origGetSession = store.getSession;
      let getSessionCalls = 0;
      store.getSession = vi.fn((convId: string) => {
        getSessionCalls++;
        // After the first getSession in idleSend, make the refresh return dead process
        if (getSessionCalls > 1 && convId === "conv-q") {
          const oldEntry = origGetSession.call(store, convId);
          if (oldEntry) {
            oldEntry.process.isAlive.mockReturnValue(false);
          }
          return oldEntry;
        }
        return origGetSession.call(store, convId);
      });

      const result = await provider.sendMessage(makeOpts({ conversationId: "conv-q", queue: true }));
      expect(result.text).toBe("reply");
      // Should have created a new session for the dead one
      expect(store.createSession.mock.calls.length).toBeGreaterThan(initialCreateCount);
    });

    it("sets reportToolCall on reused session in queue mode", async () => {
      provider.warmup("conv-q");
      const store = (provider as any).store;
      const entry = store.getSession("conv-q");
      const reporter = vi.fn();

      await provider.sendMessage(makeOpts({ conversationId: "conv-q", queue: true, reportToolCall: reporter }));
      expect(entry.process.setReportToolCall).toHaveBeenCalledWith(reporter);
    });
  });

  // ── interrupt ────────────────────────────────────────────────────────
  describe("interrupt", () => {
    it("aborts the turn when the session is busy", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.isBusy.mockReturnValue(true);

      provider.interrupt("conv-1");
      expect(entry.process.abortTurn).toHaveBeenCalled();
    });

    it("does nothing when session does not exist", () => {
      // Should not throw
      provider.interrupt("nonexistent");
    });

    it("does nothing when session is not busy", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.isBusy.mockReturnValue(false);

      provider.interrupt("conv-1");
      expect(entry.process.abortTurn).not.toHaveBeenCalled();
    });
  });

  // ── resetSession ─────────────────────────────────────────────────────
  describe("resetSession", () => {
    it("destroys the session", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      await provider.resetSession("conv-1");
      expect(store.destroySession).toHaveBeenCalledWith("conv-1");
    });

    it("re-creates session when opts include cwd", async () => {
      const store = (provider as any).store;
      await provider.resetSession("conv-1", { cwd: "/new-cwd" });
      expect(store.destroySession).toHaveBeenCalledWith("conv-1");
      expect(store.createSession).toHaveBeenCalledWith("conv-1", {
        cwd: "/new-cwd",
        model: undefined,
      });
    });

    it("re-creates session when opts include model", async () => {
      const store = (provider as any).store;
      await provider.resetSession("conv-1", { model: "opus" });
      expect(store.createSession).toHaveBeenCalledWith("conv-1", {
        cwd: undefined,
        model: "opus",
      });
    });

    it("does not re-create session when opts have neither cwd nor model", async () => {
      const store = (provider as any).store;
      await provider.resetSession("conv-1", {});
      expect(store.destroySession).toHaveBeenCalledWith("conv-1");
      expect(store.createSession).not.toHaveBeenCalled();
    });

    it("does not re-create session when called without opts", async () => {
      const store = (provider as any).store;
      await provider.resetSession("conv-1");
      expect(store.createSession).not.toHaveBeenCalled();
    });
  });

  // ── resumeSession ────────────────────────────────────────────────────
  describe("resumeSession", () => {
    it("returns true when resume succeeds", async () => {
      const result = await provider.resumeSession("conv-1", "sid-resume");
      expect(result).toBe(true);
    });

    it("returns false when store.resumeSession returns null", async () => {
      const store = (provider as any).store;
      store.resumeSession.mockResolvedValueOnce(null);
      const result = await provider.resumeSession("conv-1", "sid-gone");
      expect(result).toBe(false);
    });
  });

  // ── getSessionInfo ───────────────────────────────────────────────────
  describe("getSessionInfo", () => {
    it("returns session info for alive session", () => {
      provider.warmup("conv-1");
      const info = provider.getSessionInfo("conv-1");
      expect(info).toEqual({
        sessionId: "sid-1",
        alive: true,
        cwd: "/test",
        model: "sonnet",
      });
    });

    it("returns null when no session exists", () => {
      expect(provider.getSessionInfo("nonexistent")).toBeNull();
    });

    it("returns null when process is dead", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.isAlive.mockReturnValue(false);

      expect(provider.getSessionInfo("conv-1")).toBeNull();
    });

    it("falls back to defaultCwd when getCwd returns null", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getCwd.mockReturnValue(null);

      const info = provider.getSessionInfo("conv-1");
      expect(info!.cwd).toBe("/default");
    });
  });

  // ── getCostInfo ──────────────────────────────────────────────────────
  describe("getCostInfo", () => {
    it("returns cost info for existing session", () => {
      provider.warmup("conv-1");
      const info = provider.getCostInfo("conv-1");
      expect(info).toEqual({ totalCostUsd: 0.05 });
    });

    it("returns null when no session exists", () => {
      expect(provider.getCostInfo("nonexistent")).toBeNull();
    });
  });

  // ── getUsageInfo ─────────────────────────────────────────────────────
  describe("getUsageInfo", () => {
    it("returns null when no session exists", () => {
      expect(provider.getUsageInfo("nonexistent")).toBeNull();
    });

    it("returns null when process is dead", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.isAlive.mockReturnValue(false);

      expect(provider.getUsageInfo("conv-1")).toBeNull();
    });

    it("returns context when available", () => {
      provider.warmup("conv-1");
      const info = provider.getUsageInfo("conv-1");
      expect(info!.context).toEqual({ contextTokens: 500, contextWindow: 200000 });
    });

    it("omits context when getContext returns null", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.context).toBeUndefined();
    });

    it("includes rate limits when present", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(0);

      const rlMap = new Map();
      rlMap.set("rl-1", {
        status: "active",
        rateLimitType: "token",
        utilization: 0.5,
        resetsAt: 1700000000,
        overageStatus: "none",
        isUsingOverage: false,
      });
      entry.process.getRateLimits.mockReturnValue(rlMap);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.rateLimits).toEqual([
        {
          status: "active",
          rateLimitType: "token",
          utilization: 0.5,
          resetsAt: 1700000000,
          overageStatus: "none",
          isUsingOverage: false,
        },
      ]);
    });

    it("omits rateLimits when map is empty", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(0);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.rateLimits).toBeUndefined();
    });

    it("includes rateLimits with missing rateLimitType defaulting to 'unknown'", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(0);

      const rlMap = new Map();
      rlMap.set("rl-1", {
        status: "active",
        rateLimitType: undefined,
        utilization: 0.3,
      });
      entry.process.getRateLimits.mockReturnValue(rlMap);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.rateLimits![0].rateLimitType).toBe("unknown");
    });

    it("includes window usage when present", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(0);

      const win = { inputTokens: 100, outputTokens: 200, costUsd: 0.01, turns: 3, resetsAt: 99 };
      entry.process.getWindowUsage.mockReturnValue(win);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.window).toEqual(win);
    });

    it("omits window when getWindowUsage returns undefined", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(0);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.window).toBeUndefined();
    });

    it("includes totalCostUsd when cost > 0", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(1.23);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.totalCostUsd).toBe(1.23);
    });

    it("omits totalCostUsd when cost is 0", () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");
      entry.process.getContext.mockReturnValue(null);
      entry.process.getTotalCost.mockReturnValue(0);

      const info = provider.getUsageInfo("conv-1");
      expect(info!.totalCostUsd).toBeUndefined();
    });
  });

  // ── listSessions ─────────────────────────────────────────────────────
  describe("listSessions", () => {
    it("returns empty array when no sessions exist", () => {
      expect(provider.listSessions()).toEqual([]);
    });

    it("maps store sessions to SessionListEntry with providerId", () => {
      const store = (provider as any).store;
      store.listSessions.mockReturnValue([
        {
          sessionId: "sid-1",
          conversationId: "conv-1",
          alive: true,
          status: "ready",
          cwd: "/test",
          model: "sonnet",
          lastActivity: 1000,
        },
      ]);

      const list = provider.listSessions();
      expect(list).toEqual([
        {
          providerId: "test-provider",
          sessionId: "sid-1",
          conversationId: "conv-1",
          alive: true,
          status: "ready",
          cwd: "/test",
          model: "sonnet",
          lastActivity: 1000,
        },
      ]);
    });
  });

  // ── shutdown ─────────────────────────────────────────────────────────
  describe("shutdown", () => {
    it("calls store.stopAll()", async () => {
      const store = (provider as any).store;
      await provider.shutdown();
      expect(store.stopAll).toHaveBeenCalled();
    });
  });

  // ── setEnv ───────────────────────────────────────────────────────────
  describe("setEnv", () => {
    it("stores environment variables", () => {
      provider.setEnv("API_KEY", "secret");
      expect((provider as any).providerEnv["API_KEY"]).toBe("secret");
    });

    it("overwrites existing env vars", () => {
      provider.setEnv("KEY", "v1");
      provider.setEnv("KEY", "v2");
      expect((provider as any).providerEnv["KEY"]).toBe("v2");
    });
  });

  // ── isProcessDeadError (via directSend error handling) ───────────────
  describe("isProcessDeadError classification", () => {
    it("treats non-Error thrown values as non-dead (no retry)", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");

      entry.process.sendMessage.mockRejectedValueOnce("string error");

      await expect(provider.sendMessage(makeOpts({ conversationId: "conv-1" }))).rejects.toBe("string error");
    });
  });

  // ── context prefix integration ───────────────────────────────────────
  describe("context prefix in sent messages", () => {
    it("includes sender username context when provided", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");

      await provider.sendMessage(
        makeOpts({
          conversationId: "conv-1",
          content: "hello",
          senderUsername: "alice",
        }),
      );

      const sentContent = entry.process.sendMessage.mock.calls[0][0];
      expect(sentContent).toContain("[Message from user: alice]");
      expect(sentContent).toContain("hello");
    });

    it("sends plain content when no context metadata is present", async () => {
      provider.warmup("conv-1");
      const store = (provider as any).store;
      const entry = store.getSession("conv-1");

      await provider.sendMessage(makeOpts({ conversationId: "conv-1", content: "plain msg" }));

      const sentContent = entry.process.sendMessage.mock.calls[0][0];
      expect(sentContent).toBe("plain msg");
    });
  });
});
