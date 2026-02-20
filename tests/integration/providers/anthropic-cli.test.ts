import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicCliProvider } from "../../../src/providers/anthropic-cli.js";

// Mock ClaudeProcess — must use function keyword, not arrow
vi.mock("../../../src/claude/process.js", () => {
  return {
    ClaudeProcess: vi.fn(function (this: any) {
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.sendMessage = vi.fn(async (text: string, onText?: (t: string) => void) => {
        onText?.("Hello ");
        onText?.("world!");
        return { text: "Hello world!", sessionId: "sid-abc" };
      });
      this.isAlive = vi.fn(() => true);
      this.isBusy = vi.fn(() => false);
      this.abortTurn = vi.fn();
      this.getSessionId = vi.fn(() => "sid-abc");
      this.getTotalCost = vi.fn(() => 0.1);
      this.getCwd = vi.fn(() => "/test");
      this.getModel = vi.fn(() => "sonnet");
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
    provider = new AnthropicCliProvider(
      {
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
    it("returns anthropic models", () => {
      const models = provider.supportedModels();
      expect(models).toContain("opus");
      expect(models).toContain("sonnet");
      expect(models).toContain("haiku");
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
});
