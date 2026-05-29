import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearContextInjected,
  createPipelineState,
  runMessagePipeline,
} from "../../../src/pipeline/message-pipeline.js";
import type { PipelineContext } from "../../../src/pipeline/message-pipeline.js";
import type { Provider, SendMessageOpts } from "../../../src/providers/types.js";

function createProvider(type = "openai-cli"): Provider {
  return {
    id: `${type}-provider`,
    type,
    displayName: type,
    warmup: vi.fn(),
    sendMessage: vi.fn(async () => ({ text: "ok", sessionId: "provider-session-1" })),
    interrupt: vi.fn(),
    resetSession: vi.fn(),
    resumeSession: vi.fn(async () => true),
    getSessionInfo: vi.fn(),
    getCostInfo: vi.fn(() => null),
    getUsageInfo: vi.fn(() => null),
    listSessions: vi.fn(() => []),
    supportedModels: vi.fn(() => null),
    shutdown: vi.fn(async () => {}),
    setEnv: vi.fn(),
  };
}

function createSessionStore() {
  return {
    buildContext: vi.fn(() => "sqlite history"),
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    needsCompact: vi.fn(() => false),
    compact: vi.fn(),
  };
}

function baseCtx(provider: Provider, bridgeSessionStore: ReturnType<typeof createSessionStore>): PipelineContext {
  return {
    provider,
    bridgeSessionStore: bridgeSessionStore as never,
    sessionId: "agent:default",
    content: "hello",
    agentName: "agent",
    cwd: "/tmp",
    onChunk: vi.fn(),
    history: [
      {
        role: "user",
        content: "previous backend message",
        createdAt: "2026-05-19T00:00:00.000Z",
      },
    ],
  };
}

describe("runMessagePipeline history bootstrap", () => {
  beforeEach(() => {
    clearContextInjected("agent:default");
  });

  it.each(["anthropic-cli", "openai-cli"])(
    "uses bridge context only once for persistent %s sessions",
    async (providerType) => {
      const provider = createProvider(providerType);
      const store = createSessionStore();
      const getSessionInfo = vi.mocked(provider.getSessionInfo);
      getSessionInfo
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          sessionId: "provider-session-1",
          alive: true,
          cwd: "/tmp",
        });

      await runMessagePipeline(baseCtx(provider, store));
      await runMessagePipeline(baseCtx(provider, store));

      const firstOpts = vi.mocked(provider.sendMessage).mock.calls[0][0] as SendMessageOpts;
      const secondOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;

      expect(firstOpts.bridgeSessionContext).toBe("sqlite history");
      expect(firstOpts.history).toBeUndefined();
      expect(store.buildContext).toHaveBeenCalledOnce();
      expect(secondOpts.history).toBeUndefined();
      expect(secondOpts.bridgeSessionContext).toBeUndefined();
    },
  );

  it("falls back to backend history for bootstrap when bridge context is empty", async () => {
    const provider = createProvider("openai-cli");
    const store = createSessionStore();
    store.buildContext.mockReturnValue("");

    await runMessagePipeline({
      ...baseCtx(provider, store),
    });

    const opts = vi.mocked(provider.sendMessage).mock.calls[0][0] as SendMessageOpts;
    expect(opts.bridgeSessionContext).toBeUndefined();
    expect(opts.history).toHaveLength(1);
    expect(store.buildContext).toHaveBeenCalledOnce();
  });

  it("prefers bridge context over backend history when retrying after provider reset", async () => {
    const provider = createProvider("openai-cli");
    const store = createSessionStore();
    vi.mocked(provider.sendMessage)
      .mockRejectedValueOnce(new Error("context_length_exceeded"))
      .mockResolvedValueOnce({ text: "ok", sessionId: "provider-session-2" });

    await runMessagePipeline(baseCtx(provider, store));

    const retryOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(provider.resetSession).toHaveBeenCalledWith("agent:default", { cwd: "/tmp", model: undefined });
    expect(retryOpts.bridgeSessionContext).toBe("sqlite history");
    expect(retryOpts.history).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests using createPipelineState() for isolation
// ---------------------------------------------------------------------------

describe("createPipelineState isolation", () => {
  it("returns an independent state object", () => {
    const s1 = createPipelineState();
    const s2 = createPipelineState();
    s1.contextInjected.add("x");
    s1.lastProviderSessionId.set("x", "sid");
    expect(s2.contextInjected.has("x")).toBe(false);
    expect(s2.lastProviderSessionId.has("x")).toBe(false);
  });
});

describe("clearContextInjected", () => {
  it("removes session from both contextInjected and lastProviderSessionId", () => {
    const state = createPipelineState();
    state.contextInjected.add("s1");
    state.lastProviderSessionId.set("s1", "psid");
    clearContextInjected("s1", state);
    expect(state.contextInjected.has("s1")).toBe(false);
    expect(state.lastProviderSessionId.has("s1")).toBe(false);
  });

  it("is a no-op for unknown sessions", () => {
    const state = createPipelineState();
    clearContextInjected("nonexistent", state);
    expect(state.contextInjected.size).toBe(0);
    expect(state.lastProviderSessionId.size).toBe(0);
  });
});

describe("provider session death / respawn detection (Step 1)", () => {
  it("clears context when provider session dies between turns", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    const ctx = baseCtx(provider, store);

    // First turn: session starts, provider returns a session ID
    vi.mocked(provider.getSessionInfo).mockReturnValue(null);
    await runMessagePipeline(ctx, state);

    // state now has contextInjected for "agent:default" and lastProviderSessionId
    expect(state.contextInjected.has("agent:default")).toBe(true);
    expect(state.lastProviderSessionId.get("agent:default")).toBe("provider-session-1");

    // Second turn: provider session died (alive=false)
    vi.mocked(provider.getSessionInfo).mockReturnValue({
      sessionId: "provider-session-1",
      alive: false,
      cwd: "/tmp",
    });
    store.buildContext.mockReturnValue("refreshed context");
    await runMessagePipeline(ctx, state);

    // Context should have been re-injected (buildContext called again)
    const secondOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(secondOpts.bridgeSessionContext).toBe("refreshed context");
    expect(store.buildContext).toHaveBeenCalledTimes(2);
  });

  it("clears context when provider session ID changes (respawn)", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    const ctx = baseCtx(provider, store);

    // First turn: alive session with id "A"
    vi.mocked(provider.getSessionInfo).mockReturnValue({
      sessionId: "A",
      alive: true,
      cwd: "/tmp",
    });
    vi.mocked(provider.sendMessage).mockResolvedValue({ text: "ok", sessionId: "A" });
    await runMessagePipeline(ctx, state);
    expect(state.lastProviderSessionId.get("agent:default")).toBe("A");

    // Second turn: provider respawned — session ID changed to "B"
    vi.mocked(provider.getSessionInfo).mockReturnValue({
      sessionId: "B",
      alive: true,
      cwd: "/tmp",
    });
    vi.mocked(provider.sendMessage).mockResolvedValue({ text: "ok2", sessionId: "B" });
    store.buildContext.mockReturnValue("re-injected context");
    await runMessagePipeline(ctx, state);

    const secondOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(secondOpts.bridgeSessionContext).toBe("re-injected context");
    expect(state.lastProviderSessionId.get("agent:default")).toBe("B");
  });

  it("clears context when getSessionInfo returns null and previous ID existed", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    const ctx = baseCtx(provider, store);

    // First turn
    vi.mocked(provider.getSessionInfo).mockReturnValue(null);
    await runMessagePipeline(ctx, state);
    expect(state.contextInjected.has("agent:default")).toBe(true);

    // Second turn: session info returns null (session gone)
    vi.mocked(provider.getSessionInfo).mockReturnValue(null);
    store.buildContext.mockReturnValue("fresh context");
    await runMessagePipeline(ctx, state);

    // buildContext should be called again for the re-injection
    const secondOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(secondOpts.bridgeSessionContext).toBe("fresh context");
  });
});

describe("extraContext injection (Step 2)", () => {
  it("prepends extraContext to bridge context on first message", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      extraContext: "## Memory results\nSome memory",
    };

    await runMessagePipeline(ctx, state);

    const opts = vi.mocked(provider.sendMessage).mock.calls[0][0] as SendMessageOpts;
    expect(opts.bridgeSessionContext).toBe("## Memory results\nSome memory\n\nsqlite history");
  });

  it("uses extraContext alone when bridge context is empty", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.buildContext.mockReturnValue("");
    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      extraContext: "memory only",
    };

    await runMessagePipeline(ctx, state);

    const opts = vi.mocked(provider.sendMessage).mock.calls[0][0] as SendMessageOpts;
    // When buildContext returns empty string, bridgeSessionContext becomes undefined,
    // then extraContext becomes the sole context
    expect(opts.bridgeSessionContext).toBe("memory only");
    // historyForProvider is computed before extraContext is applied, so it keeps the fallback
    expect(opts.history).toHaveLength(1);
  });

  it("does not prepend extraContext on subsequent messages when session is alive", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    // First turn: no session info yet
    vi.mocked(provider.getSessionInfo).mockReturnValueOnce(null);
    await runMessagePipeline(baseCtx(provider, store), state);

    // Second turn: session is alive with same ID — no re-injection
    vi.mocked(provider.getSessionInfo).mockReturnValueOnce({
      sessionId: "provider-session-1",
      alive: true,
      cwd: "/tmp",
    });
    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      extraContext: "should not appear",
    };
    await runMessagePipeline(ctx, state);

    const secondOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(secondOpts.bridgeSessionContext).toBeUndefined();
  });
});

describe("error handling (Step 4)", () => {
  it("rethrows when signal is aborted", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    const controller = new AbortController();
    controller.abort();

    vi.mocked(provider.sendMessage).mockRejectedValueOnce(new Error("aborted"));

    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      signal: controller.signal,
    };

    await expect(runMessagePipeline(ctx, state)).rejects.toThrow("aborted");
    // Should NOT have called resetSession
    expect(provider.resetSession).not.toHaveBeenCalled();
  });

  it("rethrows non-unrecoverable errors without resetting", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    vi.mocked(provider.sendMessage).mockRejectedValueOnce(new Error("network timeout"));

    await expect(runMessagePipeline(baseCtx(provider, store), state)).rejects.toThrow("network timeout");
    expect(provider.resetSession).not.toHaveBeenCalled();
  });

  it("retries with extraContext in retry path when bridge context available", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.buildContext.mockReturnValue("bridge ctx");

    vi.mocked(provider.sendMessage)
      .mockRejectedValueOnce(new Error("exceeds the dimension limit"))
      .mockResolvedValueOnce({ text: "retried", sessionId: "ps-2" });

    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      extraContext: "memory context",
    };
    const result = await runMessagePipeline(ctx, state);

    expect(result.text).toBe("retried");
    const retryOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(retryOpts.bridgeSessionContext).toBe("memory context\n\nbridge ctx");
    expect(retryOpts.history).toBeUndefined();
  });

  it("retries with extraContext alone when bridge context is empty", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.buildContext.mockReturnValue("");

    vi.mocked(provider.sendMessage)
      .mockRejectedValueOnce(new Error("prompt is too long"))
      .mockResolvedValueOnce({ text: "retried", sessionId: "ps-2" });

    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      extraContext: "extra only",
    };
    const result = await runMessagePipeline(ctx, state);

    expect(result.text).toBe("retried");
    const retryOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(retryOpts.bridgeSessionContext).toBe("extra only");
    // retryHistory is computed before extraContext is applied, so backend history still present
    expect(retryOpts.history).toHaveLength(1);
  });

  it("falls back to backend history in retry when bridge context is empty and no extraContext", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.buildContext.mockReturnValue("");

    vi.mocked(provider.sendMessage)
      .mockRejectedValueOnce(new Error("context_length_exceeded"))
      .mockResolvedValueOnce({ text: "retried", sessionId: "ps-2" });

    const result = await runMessagePipeline(baseCtx(provider, store), state);

    expect(result.text).toBe("retried");
    const retryOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(retryOpts.bridgeSessionContext).toBeUndefined();
    expect(retryOpts.history).toHaveLength(1);
  });

  it("marks injectedContextThisTurn true after successful retry", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    vi.mocked(provider.sendMessage)
      .mockRejectedValueOnce(new Error("exceeds the dimension limit"))
      .mockResolvedValueOnce({ text: "ok", sessionId: "ps-retry" });

    await runMessagePipeline(baseCtx(provider, store), state);

    expect(state.contextInjected.has("agent:default")).toBe(true);
    expect(state.lastProviderSessionId.get("agent:default")).toBe("ps-retry");
  });
});

describe("auto-compaction (Step 7)", () => {
  it("triggers compaction when needsCompact returns true", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.needsCompact.mockReturnValue(true);
    store.compact.mockImplementation(async (
      _sid: string,
      fn: (msgs: Array<{ role: string; content: string; sender?: string; userMessage?: string }>, summary?: string) => Promise<string>,
    ) => {
      const summary = await fn(
        [
          { role: "user", content: "hi", sender: "user", userMessage: "hi" },
          { role: "assistant", content: "hello", sender: "agent" },
        ],
        undefined,
      );
      expect(summary).toBe("compacted summary");
    });

    // Mock the compact sendMessage call
    vi.mocked(provider.sendMessage)
      .mockResolvedValueOnce({ text: "ok", sessionId: "ps-1" }) // main send
      .mockResolvedValueOnce({ text: "compacted summary", sessionId: "ps-compact" }); // compact send

    vi.mocked(provider.getUsageInfo).mockReturnValue({
      context: { contextTokens: 150_000, contextWindow: 200_000 },
    });

    const result = await runMessagePipeline(baseCtx(provider, store), state);

    expect(result.compacted).toBe(true);
    expect(store.needsCompact).toHaveBeenCalledWith("agent:default", undefined, 200_000);
    // After compaction, provider session is reset and context is cleared
    expect(provider.resetSession).toHaveBeenCalledWith("agent:default", { cwd: "/tmp", model: undefined });
    expect(state.contextInjected.has("agent:default")).toBe(false);
  });

  it("uses compactModel override when provided", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.needsCompact.mockReturnValue(true);
    store.compact.mockImplementation(async (
      _sid: string,
      fn: (msgs: Array<{ role: string; content: string }>, summary?: string) => Promise<string>,
    ) => {
      await fn([{ role: "user", content: "hi" }], undefined);
    });

    vi.mocked(provider.sendMessage)
      .mockResolvedValueOnce({ text: "ok", sessionId: "ps-1" })
      .mockResolvedValueOnce({ text: "summary", sessionId: "ps-compact" });

    vi.mocked(provider.getUsageInfo).mockReturnValue(null);

    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      model: "gpt-4.1",
      compactModel: "gpt-4.1-mini",
    };
    await runMessagePipeline(ctx, state);

    // The compact sendMessage should use compactModel
    const compactOpts = vi.mocked(provider.sendMessage).mock.calls[1][0] as SendMessageOpts;
    expect(compactOpts.model).toBe("gpt-4.1-mini");
    expect(compactOpts.conversationId).toBe("agent:default:compact");
  });

  it("handles compact failure gracefully (logs warning, continues)", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.needsCompact.mockReturnValue(true);
    store.compact.mockRejectedValueOnce(new Error("compact boom"));

    vi.mocked(provider.getUsageInfo).mockReturnValue(null);

    const result = await runMessagePipeline(baseCtx(provider, store), state);

    expect(result.compacted).toBe(false);
    expect(result.text).toBe("ok");
    // Session should NOT have been reset since compact failed before that step
    expect(provider.resetSession).not.toHaveBeenCalled();
  });

  it("passes runtime context window to needsCompact", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.needsCompact.mockReturnValue(false);

    vi.mocked(provider.getUsageInfo).mockReturnValue({
      context: { contextTokens: 50_000, contextWindow: 300_000 },
    });

    await runMessagePipeline(baseCtx(provider, store), state);

    expect(store.needsCompact).toHaveBeenCalledWith("agent:default", undefined, 300_000);
  });

  it("passes undefined context window when getUsageInfo returns null", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();
    store.needsCompact.mockReturnValue(false);

    vi.mocked(provider.getUsageInfo).mockReturnValue(null);

    await runMessagePipeline(baseCtx(provider, store), state);

    expect(store.needsCompact).toHaveBeenCalledWith("agent:default", undefined, undefined);
  });
});

describe("result shape (Step 5/6/return)", () => {
  it("returns full pipeline result with all fields", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    vi.mocked(provider.sendMessage).mockResolvedValueOnce({
      text: "response text",
      sessionId: "psid",
      durationMs: 1234,
      numTurns: 3,
    });

    const result = await runMessagePipeline(baseCtx(provider, store), state);

    expect(result).toEqual({
      text: "response text",
      sessionId: "psid",
      durationMs: 1234,
      numTurns: 3,
      compacted: false,
    });
  });

  it("records user and assistant messages in bridge session store", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    vi.mocked(provider.sendMessage).mockResolvedValueOnce({
      text: "assistant reply",
      sessionId: "ps-1",
    });

    const ctx: PipelineContext = {
      ...baseCtx(provider, store),
      senderName: "testuser",
      model: "gpt-4.1",
      userMessageMeta: { extra: true },
    };
    await runMessagePipeline(ctx, state);

    expect(store.addUserMessage).toHaveBeenCalledWith(
      "agent:default",
      "hello",
      "testuser",
      { model: "gpt-4.1", extra: true },
    );
    expect(store.addAssistantMessage).toHaveBeenCalledWith(
      "agent:default",
      "assistant reply",
      "agent",
      { model: "gpt-4.1" },
    );
  });

  it("tracks provider session ID when sendResult includes one", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    vi.mocked(provider.sendMessage).mockResolvedValueOnce({
      text: "ok",
      sessionId: "tracked-id",
    });

    await runMessagePipeline(baseCtx(provider, store), state);

    expect(state.lastProviderSessionId.get("agent:default")).toBe("tracked-id");
  });

  it("does not set lastProviderSessionId when sendResult has no sessionId", async () => {
    const state = createPipelineState();
    const provider = createProvider();
    const store = createSessionStore();

    vi.mocked(provider.sendMessage).mockResolvedValueOnce({
      text: "ok",
    });

    await runMessagePipeline(baseCtx(provider, store), state);

    expect(state.lastProviderSessionId.has("agent:default")).toBe(false);
  });
});
