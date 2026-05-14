import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicCliProvider } from "../../../src/providers/anthropic-cli.js";

type ProcBehavior = {
  send?: (text: string, onText?: (t: string) => void) => Promise<any>;
  alive?: boolean;
};
/** FIFO of per-instance process behaviors; tests push before creating sessions. */
const procScripts: ProcBehavior[] = [];
/** All mock process instances created during the current test. */
const procInstances: any[] = [];
/** Constructor opts received by each mock ClaudeProcess (aligned with procInstances). */
const procCtorOpts: any[] = [];

// Mock PtyProcess — must use function keyword, not arrow
vi.mock("../../../src/claude/pty-process.js", () => {
  return {
    PtyProcess: vi.fn(function (this: any, opts: any) {
      const script = procScripts.shift() ?? {};
      this.opts = opts;
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.sendMessage = vi.fn(
        script.send ??
          (async (_text: string, onText?: (t: string) => void) => {
            onText?.("Hello ");
            onText?.("world!");
            return { text: "Hello world!", sessionId: "sid-abc" };
          }),
      );
      this.isAlive = vi.fn(() => script.alive ?? true);
      this.isBusy = vi.fn(() => false);
      this.abortTurn = vi.fn();
      this.getSessionId = vi.fn(() => "sid-abc");
      this.getTotalCost = vi.fn(() => 0.1);
      this.getCwd = vi.fn(() => "/test");
      this.getModel = vi.fn(() => "sonnet");
      this.setReportToolCall = vi.fn((reporter: any) => { this.opts.reportToolCall = reporter; });
      procInstances.push(this);
      procCtorOpts.push(opts);
    }),
  };
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("AnthropicCliProvider", () => {
  let provider: AnthropicCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    procScripts.length = 0;
    procInstances.length = 0;
    procCtorOpts.length = 0;
    provider = new AnthropicCliProvider(
      {
        providerId: "anthropic-oauth",
        displayName: "Anthropic OAuth",
        claudePath: "claude",
        defaultCwd: "/default",
        maxSessions: 3,
        idleTimeoutMs: 600_000,
      },
      logger,
    );
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("has correct id and displayName", () => {
    expect(provider.id).toBe("anthropic-oauth");
    expect(provider.displayName).toContain("Anthropic");
  });

  describe("sendMessage", () => {
    it("sends message and returns result", async () => {
      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-1",
        content: "Hello",
        onChunk: (text) => chunks.push(text),
      });

      expect(result.text).toBe("Hello world!");
      expect(result.sessionId).toBe("sid-abc");
      expect(chunks).toEqual(["Hello ", "world!"]);
    });

    it("reuses existing session", async () => {
      const noop = () => {};
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "msg1",
        onChunk: noop,
      });

      await provider.sendMessage({
        conversationId: "conv-1",
        content: "msg2",
        onChunk: noop,
      });

      const sessions = provider.listSessions();
      expect(sessions).toHaveLength(1);
    });
  });

  describe("interrupt", () => {
    it("aborts turn on active session", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      provider.interrupt("conv-1");
      provider.interrupt("conv-999"); // Should not throw
    });
  });

  describe("resetSession", () => {
    it("destroys and optionally recreates session", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      await provider.resetSession("conv-1", { cwd: "/new", model: "opus" });

      const info = provider.getSessionInfo("conv-1");
      expect(info).not.toBeNull();
    });
  });

  describe("getSessionInfo", () => {
    it("returns null for non-existent session", () => {
      expect(provider.getSessionInfo("conv-999")).toBeNull();
    });

    it("returns info for active session", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const info = provider.getSessionInfo("conv-1");
      expect(info).not.toBeNull();
      expect(info!.sessionId).toBe("sid-abc");
      expect(info!.alive).toBe(true);
      expect(info!.cwd).toBe("/test");
    });
  });

  describe("getCostInfo", () => {
    it("returns cost for active session", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const cost = provider.getCostInfo("conv-1");
      expect(cost).not.toBeNull();
      expect(cost!.totalCostUsd).toBe(0.1);
    });
  });

  describe("listSessions", () => {
    it("lists all sessions with provider ID", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const sessions = provider.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].providerId).toBe("anthropic-oauth");
    });
  });

  describe("supportedModels", () => {
    it("returns null when no models configured", () => {
      const models = provider.supportedModels();
      expect(models).toBeNull();
    });

    it("returns custom models when configured", () => {
      const customProvider = new AnthropicCliProvider(
        {
          providerId: "minimax",
          displayName: "MiniMax",
          claudePath: "claude",
          defaultCwd: "/default",
          maxSessions: 3,
          idleTimeoutMs: 600_000,
          models: ["MiniMax-M2.5", "MiniMax-M2.1"],
        },
        logger,
      );
      expect(customProvider.supportedModels()).toEqual(["MiniMax-M2.5", "MiniMax-M2.1"]);
    });
  });

  describe("resumeSession", () => {
    it("resumes session by ID", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      await provider.resetSession("conv-1");
      const ok = await provider.resumeSession("conv-1", "sid-abc");
      expect(ok).toBe(true);
    });
  });

  describe("directSend respawn on process death", () => {
    it("respawns and retries when sendMessage rejects with 'Claude process is not running'", async () => {
      procScripts.push({
        send: async () => {
          throw new Error("Claude process is not running");
        },
      });
      procScripts.push({
        send: async (_text, onText) => {
          onText?.("recovered");
          return { text: "recovered", sessionId: "sid-new" };
        },
      });

      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-crash",
        content: "ping",
        onChunk: (t) => chunks.push(t),
      });

      expect(result.text).toBe("recovered");
      expect(result.sessionId).toBe("sid-new");
      expect(chunks).toEqual(["recovered"]);
      // First process created, dies, second process spawned → 2 instances.
      expect(procInstances).toHaveLength(2);
    });

    it("respawns when process exits mid-turn", async () => {
      procScripts.push({
        send: async () => {
          throw new Error("Claude process exited unexpectedly (code 0)");
        },
      });
      procScripts.push({
        send: async () => ({ text: "after restart", sessionId: "sid-new" }),
      });

      const result = await provider.sendMessage({
        conversationId: "conv-exit",
        content: "ping",
        onChunk: () => {},
      });

      expect(result.text).toBe("after restart");
      expect(procInstances).toHaveLength(2);
    });

    it("does NOT retry non-process-death errors", async () => {
      procScripts.push({
        send: async () => {
          throw new Error("Another message is already in-flight");
        },
      });

      await expect(
        provider.sendMessage({
          conversationId: "conv-other",
          content: "ping",
          onChunk: () => {},
        }),
      ).rejects.toThrow("Another message is already in-flight");
      // No respawn attempted.
      expect(procInstances).toHaveLength(1);
    });

    it("does NOT retry when caller aborted the signal", async () => {
      const ctrl = new AbortController();
      procScripts.push({
        send: async () => {
          ctrl.abort();
          throw new Error("Claude process is not running");
        },
      });

      await expect(
        provider.sendMessage({
          conversationId: "conv-abort",
          content: "ping",
          onChunk: () => {},
          signal: ctrl.signal,
        }),
      ).rejects.toThrow("Claude process is not running");
      expect(procInstances).toHaveLength(1);
    });

    it("caps retries at 1 — if respawned process also dies, surface the error", async () => {
      procScripts.push({
        send: async () => {
          throw new Error("Claude process is not running");
        },
      });
      procScripts.push({
        send: async () => {
          throw new Error("Claude process exited unexpectedly (code 1)");
        },
      });
      // A third script — if retry loop were unbounded, it would reach this and succeed.
      procScripts.push({
        send: async () => ({ text: "should not reach", sessionId: "sid-3" }),
      });

      await expect(
        provider.sendMessage({
          conversationId: "conv-cap",
          content: "ping",
          onChunk: () => {},
        }),
      ).rejects.toThrow("Claude process exited unexpectedly");
      // Exactly 2 spawn attempts — original + 1 retry.
      expect(procInstances).toHaveLength(2);
    });
  });

  describe("reportToolCall wiring", () => {
    it("threads reportToolCall from sendMessage to the ClaudeProcess constructor", async () => {
      const reporter = vi.fn();

      await provider.sendMessage({
        conversationId: "conv-report",
        content: "hi",
        onChunk: () => {},
        reportToolCall: reporter,
      });

      expect(procCtorOpts).toHaveLength(1);
      expect(procCtorOpts[0].reportToolCall).toBe(reporter);
    });

    it("refreshes reportToolCall on an already-alive session via setReportToolCall", async () => {
      const firstReporter = vi.fn();
      const secondReporter = vi.fn();

      await provider.sendMessage({
        conversationId: "conv-refresh",
        content: "first",
        onChunk: () => {},
        reportToolCall: firstReporter,
      });
      await provider.sendMessage({
        conversationId: "conv-refresh",
        content: "second",
        onChunk: () => {},
        reportToolCall: secondReporter,
      });

      // Only one process created (session reused), but setter called twice.
      expect(procInstances).toHaveLength(1);
      expect(procInstances[0].setReportToolCall).toHaveBeenCalledWith(firstReporter);
      expect(procInstances[0].setReportToolCall).toHaveBeenCalledWith(secondReporter);
      // Latest reporter wins.
      expect(procInstances[0].opts.reportToolCall).toBe(secondReporter);
    });

    it("passes reportToolCall to the respawned process after a crash", async () => {
      const reporter = vi.fn();
      procScripts.push({
        send: async () => {
          throw new Error("Claude process is not running");
        },
      });
      procScripts.push({
        send: async () => ({ text: "ok", sessionId: "sid-new" }),
      });

      await provider.sendMessage({
        conversationId: "conv-crash-report",
        content: "ping",
        onChunk: () => {},
        reportToolCall: reporter,
      });

      expect(procCtorOpts).toHaveLength(2);
      expect(procCtorOpts[0].reportToolCall).toBe(reporter);
      expect(procCtorOpts[1].reportToolCall).toBe(reporter);
    });

    it("warmup forwards reportToolCall to the ClaudeProcess constructor", () => {
      const reporter = vi.fn();
      provider.warmup("conv-warm", {
        cwd: "/w",
        model: "sonnet",
        reportToolCall: reporter,
      });

      expect(procCtorOpts).toHaveLength(1);
      expect(procCtorOpts[0].reportToolCall).toBe(reporter);
    });
  });

  describe("env injection", () => {
    it("creates provider with custom env (e.g. MiniMax)", () => {
      const envProvider = new AnthropicCliProvider(
        {
          providerId: "minimax",
          displayName: "MiniMax",
          claudePath: "claude",
          defaultCwd: "/default",
          maxSessions: 3,
          idleTimeoutMs: 600_000,
          env: {
            ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
            ANTHROPIC_AUTH_TOKEN: "sk-mm-test",
          },
          models: ["MiniMax-M2.5", "MiniMax-M2.1"],
        },
        logger,
      );
      expect(envProvider.id).toBe("minimax");
      expect(envProvider.type).toBe("anthropic-cli");
      expect(envProvider.displayName).toBe("MiniMax");
      expect(envProvider.supportedModels()).toEqual(["MiniMax-M2.5", "MiniMax-M2.1"]);
    });
  });
});
