import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearContextInjected, runMessagePipeline } from "../../../src/pipeline/message-pipeline.js";
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

function baseCtx(provider: Provider, bridgeSessionStore: ReturnType<typeof createSessionStore>) {
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
