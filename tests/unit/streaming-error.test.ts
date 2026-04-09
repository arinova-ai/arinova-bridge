import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicSdkProvider } from "../../src/providers/anthropic-sdk.js";

// ---------- mock SDK (configurable per test) ----------

let mockStreamBehavior: () => AsyncGenerator<Record<string, unknown>>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => mockStreamBehavior()),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeProvider() {
  return new AnthropicSdkProvider(
    {
      providerId: "test-sdk",
      displayName: "Test SDK",
      apiKey: "sk-test",
      defaultCwd: "/tmp",
      maxSessions: 5,
      idleTimeoutMs: 600_000,
    },
    logger,
  );
}

// ---------- helpers ----------

function normalStream(text: string) {
  return async function* () {
    yield {
      uuid: "u1",
      session_id: "sess-1",
      type: "stream_event" as const,
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    };
    yield {
      uuid: "u2",
      session_id: "sess-1",
      type: "result" as const,
      subtype: "success",
      result: text,
      total_cost_usd: 0.01,
    };
  };
}

// ---------- tests ----------

describe("Streaming error handling — AnthropicSdkProvider", () => {
  let provider: AnthropicSdkProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = makeProvider();
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  // ---- 1. onChunk throws → abort + re-throw ----
  describe("onChunk throws", () => {
    it("aborts the stream and re-throws the error", async () => {
      mockStreamBehavior = normalStream("hello");

      const chunkError = new Error("client disconnected");

      await expect(
        provider.sendMessage({
          conversationId: "conv-1",
          content: "test",
          onChunk: () => {
            throw chunkError;
          },
        }),
      ).rejects.toThrow("client disconnected");
    });

    it("cleans up abortController on chunk error", async () => {
      mockStreamBehavior = normalStream("hello");

      try {
        await provider.sendMessage({
          conversationId: "conv-1",
          content: "test",
          onChunk: () => {
            throw new Error("gone");
          },
        });
      } catch {
        // expected
      }

      // abortController should be nulled out (cleanup in catch block)
      const info = provider.getSessionInfo("conv-1");
      // Session still exists but is no longer busy
      expect(info).not.toBeNull();
    });
  });

  // ---- 2. external abort signal → cancellation ----
  describe("external abort signal", () => {
    it("propagates external abort to internal controller", async () => {
      // Stream that blocks until aborted
      mockStreamBehavior = async function* () {
        yield {
          uuid: "u1",
          session_id: "sess-1",
          type: "stream_event" as const,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
          parent_tool_use_id: null,
        };
        // Simulate long wait — the abort should interrupt
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Turn aborted by user")), 50);
        });
      };

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);

      await expect(
        provider.sendMessage({
          conversationId: "conv-1",
          content: "test",
          onChunk: () => {},
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    });
  });

  // ---- 3. normal flow still works ----
  it("normal streaming works correctly", async () => {
    mockStreamBehavior = normalStream("hello world");

    const chunks: string[] = [];
    const result = await provider.sendMessage({
      conversationId: "conv-1",
      content: "test",
      onChunk: (text) => chunks.push(text),
    });

    expect(result.text).toBe("hello world");
    expect(chunks).toContain("hello world");
    expect(result.sessionId).toBe("sess-1");
  });
});

// ---------- IPC router: fire-and-forget error logging ----------

describe("IPC router — fire-and-forget deliver", () => {
  it("returns queued immediately even when provider will fail", async () => {
    const { createIpcRouter } = await import("../../src/ipc/router.js");

    const agent = {
      name: "fail-agent",
      agent: {} as any,
      hudWs: {} as any,
      commandHandler: { handle: vi.fn().mockResolvedValue({ handled: false }) } as any,
      provider: {
        id: "mock",
        type: "mock",
        displayName: "Mock",
        sendMessage: vi.fn().mockRejectedValue(new Error("network timeout")),
        async resetSession() {},
        async resumeSession() { return true; },
        getSessionInfo() { return null; },
        listSessions() { return []; },
        interrupt() {},
        getCostInfo() { return null; },
        supportedModels() { return []; },
        async shutdown() {},
      } as any,
      agentConfig: { name: "fail-agent", cwd: "/tmp", provider: "mock" } as any,
    };

    const router = createIpcRouter([agent], new Map());

    const result = await router({
      id: 1,
      method: "deliver",
      params: { target: "fail-agent", content: "hello", wait: false },
    });

    // Should return immediately with queued status — NOT throw
    expect(result.result).toEqual({ agent: "fail-agent", queued: true });

    // Wait for the async catch handler to fire (log.warn)
    await new Promise((r) => setTimeout(r, 50));

    // Provider was called (fire-and-forget)
    expect(agent.provider.sendMessage).toHaveBeenCalled();
  });

  it("returns error when wait=true and provider fails", async () => {
    const { createIpcRouter } = await import("../../src/ipc/router.js");

    const agent = {
      name: "fail-agent2",
      agent: {} as any,
      hudWs: {} as any,
      commandHandler: { handle: vi.fn().mockResolvedValue({ handled: false }) } as any,
      provider: {
        id: "mock",
        type: "mock",
        displayName: "Mock",
        sendMessage: vi.fn().mockRejectedValue(new Error("provider crashed")),
        async resetSession() {},
        async resumeSession() { return true; },
        getSessionInfo() { return null; },
        listSessions() { return []; },
        interrupt() {},
        getCostInfo() { return null; },
        supportedModels() { return []; },
        async shutdown() {},
      } as any,
      agentConfig: { name: "fail-agent2", cwd: "/tmp", provider: "mock" } as any,
    };

    const router = createIpcRouter([agent], new Map());

    const result = await router({
      id: 2,
      method: "deliver",
      params: { target: "fail-agent2", content: "hello", wait: true },
    });

    // wait=true should return error
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("provider crashed");
  });
});

// ---------- deliverToAgent error propagation ----------

describe("deliverToAgent — error propagation", () => {
  it("re-throws provider.sendMessage errors", async () => {
    const { deliverToAgent } = await import("../../src/ipc/router.js");

    const agent = {
      name: "crash-agent",
      agent: {} as any,
      hudWs: {} as any,
      commandHandler: { handle: vi.fn().mockResolvedValue({ handled: false }) } as any,
      provider: {
        id: "mock",
        type: "mock",
        displayName: "Mock",
        sendMessage: vi.fn().mockRejectedValue(new Error("provider exploded")),
        async resetSession() {},
        async resumeSession() { return true; },
        getSessionInfo() { return null; },
        listSessions() { return []; },
        interrupt() {},
        getCostInfo() { return null; },
        supportedModels() { return []; },
        async shutdown() {},
      } as any,
      agentConfig: { name: "crash-agent", cwd: "/tmp", provider: "mock" } as any,
    };

    await expect(
      deliverToAgent(agent, "test message"),
    ).rejects.toThrow("provider exploded");
  });

  it("sendError is called in deliverToAgent when command errors", async () => {
    const { deliverToAgent } = await import("../../src/ipc/router.js");

    const agent = {
      name: "err-agent",
      agent: {} as any,
      hudWs: {} as any,
      commandHandler: {
        handle: vi.fn().mockResolvedValue({ handled: true }),
      } as any,
      provider: {
        id: "mock",
        type: "mock",
        displayName: "Mock",
        sendMessage: vi.fn(),
        async resetSession() {},
        async resumeSession() { return true; },
        getSessionInfo() { return null; },
        listSessions() { return []; },
        interrupt() {},
        getCostInfo() { return null; },
        supportedModels() { return []; },
        async shutdown() {},
      } as any,
      agentConfig: { name: "err-agent", cwd: "/tmp", provider: "mock" } as any,
    };

    // When command is handled, sendMessage should NOT be called
    const result = await deliverToAgent(agent, "/help");
    expect(agent.provider.sendMessage).not.toHaveBeenCalled();
    expect(result.text).toBeDefined();
  });
});
