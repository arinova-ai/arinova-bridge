import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverToAgent, clearA2aContextInjected } from "../../../src/ipc/router.js";
import type { ActiveAgent } from "../../../src/ipc/types.js";
import type { Provider } from "../../../src/providers/types.js";
import type { BridgeSessionStore } from "../../../src/session/bridge-session.js";

// ---------------------------------------------------------------------------
// A2A compact trigger tests
// ---------------------------------------------------------------------------

function createMockProvider(): Provider {
  return {
    id: "openai-api",
    type: "openai-cli",
    displayName: "OpenAI",
    sendMessage: vi.fn(async () => ({ text: "response" })),
    interrupt: vi.fn(),
    resetSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => true),
    getSessionInfo: vi.fn(() => null),
    getCostInfo: vi.fn(() => ({ totalCostUsd: 0 })),
    listSessions: vi.fn(() => []),
    supportedModels: vi.fn(() => []),
    shutdown: vi.fn(async () => {}),
  };
}

function createMockCommandHandler() {
  return {
    handle: vi.fn(async () => ({ handled: false })),
  };
}

function createMockSessionStore(overrides: Partial<BridgeSessionStore> = {}): BridgeSessionStore {
  return {
    addUserMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    needsCompact: vi.fn(() => false),
    compact: vi.fn(async () => {}),
    buildContext: vi.fn(() => null),
    ...overrides,
  } as unknown as BridgeSessionStore;
}

function createTarget(providerOverride?: Provider, compactModel?: string): ActiveAgent {
  const provider = providerOverride ?? createMockProvider();
  return {
    agent: {} as any,
    name: "test-agent",
    hudWs: {} as any,
    commandHandler: createMockCommandHandler() as any,
    provider,
    agentConfig: {
      name: "test-agent",
      botToken: "tok",
      provider: "openai-cli",
      cwd: "/test",
      model: "gpt-4.1",
      compactModel,
    },
  };
}

describe("A2A context injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearA2aContextInjected("test-agent:default");
  });

  it("calls buildContext on first A2A message for a session", async () => {
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn(() => "previous context here"),
    });
    const provider = createMockProvider();
    const target = createTarget(provider);

    await deliverToAgent(target, "hello", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    expect(sessionStore.buildContext).toHaveBeenCalledWith("test-agent:default");
    // bridgeSessionContext should be passed to sendMessage
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeSessionContext: "previous context here",
      }),
    );
  });

  it("skips buildContext on subsequent A2A messages (same session)", async () => {
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn(() => "context"),
    });
    const provider = createMockProvider();
    const target = createTarget(provider);

    // First call — should inject
    await deliverToAgent(target, "msg 1", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });
    expect(sessionStore.buildContext).toHaveBeenCalledTimes(1);

    // Second call — should skip
    await deliverToAgent(target, "msg 2", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });
    // buildContext is called again but result is NOT passed to sendMessage
    const secondCall = vi.mocked(provider.sendMessage).mock.calls[1][0];
    expect(secondCall.bridgeSessionContext).toBeUndefined();
  });

  it("re-injects after clearA2aContextInjected is called", async () => {
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn(() => "recovered context"),
    });
    const provider = createMockProvider();
    const target = createTarget(provider);

    // First call
    await deliverToAgent(target, "msg 1", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    // Simulate /model or /compact reset
    clearA2aContextInjected("test-agent:default");

    // Third call — should re-inject
    await deliverToAgent(target, "msg 2", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    const thirdCall = vi.mocked(provider.sendMessage).mock.calls[1][0];
    expect(thirdCall.bridgeSessionContext).toBe("recovered context");
  });

  it("passes undefined bridgeSessionContext when buildContext returns empty string", async () => {
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn(() => ""),
    });
    const provider = createMockProvider();
    const target = createTarget(provider);

    await deliverToAgent(target, "hello", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeSessionContext: undefined,
      }),
    );
  });

  it("records user message AFTER buildContext to avoid duplication", async () => {
    const callOrder: string[] = [];
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn(() => {
        callOrder.push("buildContext");
        return "context";
      }),
      addUserMessage: vi.fn(() => {
        callOrder.push("addUserMessage");
      }),
    });
    const target = createTarget();

    await deliverToAgent(target, "hello", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    expect(callOrder[0]).toBe("buildContext");
    expect(callOrder[1]).toBe("addUserMessage");
  });
});

describe("A2A + Chat tracking independence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearA2aContextInjected("test-agent:default");
  });

  it("clearA2aContextInjected only resets A2A tracking — does not affect Chat tracking", async () => {
    // The Chat tracking set (contextInjectedSessions) lives in index.ts and
    // is NOT exported. clearA2aContextInjected only touches the a2a set.
    // Verify: after clearing A2A flag, first A2A message re-injects but
    // this doesn't prove Chat was affected — it proves independence.
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn()
        .mockReturnValueOnce("ctx-1")
        .mockReturnValueOnce("ctx-2"),
    });
    const provider = createMockProvider();
    const target = createTarget(provider);

    // 1st A2A message — injects
    await deliverToAgent(target, "msg 1", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });
    expect(vi.mocked(provider.sendMessage).mock.calls[0][0].bridgeSessionContext).toBe("ctx-1");

    // Clear ONLY A2A flag
    clearA2aContextInjected("test-agent:default");

    // 2nd A2A message — should re-inject (A2A flag was cleared)
    await deliverToAgent(target, "msg 2", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });
    expect(vi.mocked(provider.sendMessage).mock.calls[1][0].bridgeSessionContext).toBe("ctx-2");
  });

  it("A2A injection flag is per-session: different sessions are independent", async () => {
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn(() => "context-data"),
    });

    // Target for session A
    const providerA = createMockProvider();
    const targetA = createTarget(providerA);

    // Target for session B (different agent name)
    const providerB = createMockProvider();
    const targetB: ActiveAgent = {
      ...createTarget(providerB),
      name: "other-agent",
      agentConfig: { ...createTarget(providerB).agentConfig, name: "other-agent" },
    };
    clearA2aContextInjected("other-agent:default");

    // First message to A — injects
    await deliverToAgent(targetA, "msg", {
      source: "agent-x",
      bridgeSessionStore: sessionStore,
    });
    expect(vi.mocked(providerA.sendMessage).mock.calls[0][0].bridgeSessionContext).toBe("context-data");

    // First message to B — also injects (independent tracking)
    await deliverToAgent(targetB, "msg", {
      source: "agent-x",
      bridgeSessionStore: sessionStore,
    });
    expect(vi.mocked(providerB.sendMessage).mock.calls[0][0].bridgeSessionContext).toBe("context-data");
  });
});

describe("A2A compact trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearA2aContextInjected("test-agent:default");
  });

  it("triggers compact when needsCompact returns true after response", async () => {
    const provider = createMockProvider();
    const sessionStore = createMockSessionStore({
      needsCompact: vi.fn(() => true),
      compact: vi.fn(async (_convId, summariser) => {
        await summariser(
          [{ role: "user", content: "test msg", timestamp: Date.now() }],
          undefined,
        );
      }),
    });

    const target = createTarget(provider, "gpt-4.1-nano");

    await deliverToAgent(target, "hello", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    // compact() should have been called
    expect(sessionStore.compact).toHaveBeenCalledWith(
      "test-agent:default",
      expect.any(Function),
      expect.objectContaining({ model: "gpt-4.1-nano" }),
    );

    // sendMessage should be called twice: once for main response, once for compact summariser
    expect(provider.sendMessage).toHaveBeenCalledTimes(2);

    // Second call (compact) should use :compact conversation ID and compactModel
    const compactCall = vi.mocked(provider.sendMessage).mock.calls[1][0];
    expect(compactCall.conversationId).toBe("test-agent:default:compact");
    expect(compactCall.model).toBe("gpt-4.1-nano");
    expect(compactCall.systemPrompt).toContain("summariser");
  });

  it("does NOT trigger compact when needsCompact returns false", async () => {
    const sessionStore = createMockSessionStore({
      needsCompact: vi.fn(() => false),
    });

    const target = createTarget();
    await deliverToAgent(target, "hello", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    expect(sessionStore.compact).not.toHaveBeenCalled();
  });

  it("uses agentConfig.compactModel when set, falls back to session model otherwise", async () => {
    // With compactModel
    const provider1 = createMockProvider();
    const sessionStore1 = createMockSessionStore({
      needsCompact: vi.fn(() => true),
      compact: vi.fn(async (_convId, summariser) => {
        await summariser([{ role: "user", content: "x", timestamp: 0 }], undefined);
      }),
    });
    const target1 = createTarget(provider1, "gpt-4.1-nano");

    await deliverToAgent(target1, "test", {
      bridgeSessionStore: sessionStore1,
      model: "gpt-4.1",
    });

    expect(sessionStore1.compact).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ model: "gpt-4.1-nano" }),
    );

    // Without compactModel — should fall back to session model
    const provider2 = createMockProvider();
    const sessionStore2 = createMockSessionStore({
      needsCompact: vi.fn(() => true),
      compact: vi.fn(async (_convId, summariser) => {
        await summariser([{ role: "user", content: "x", timestamp: 0 }], undefined);
      }),
    });
    const target2 = createTarget(provider2, undefined); // no compactModel

    await deliverToAgent(target2, "test", {
      bridgeSessionStore: sessionStore2,
      model: "gpt-4.1",
    });

    // Falls back to opts.model = "gpt-4.1"
    expect(sessionStore2.compact).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ model: "gpt-4.1" }),
    );
  });

  it("compact failure does not break A2A delivery — logs warning silently", async () => {
    const sessionStore = createMockSessionStore({
      needsCompact: vi.fn(() => true),
      compact: vi.fn(async () => {
        throw new Error("DB connection lost");
      }),
    });

    const target = createTarget();
    // Should NOT throw — compact error is caught internally
    const result = await deliverToAgent(target, "hello", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    expect(result.text).toBe("response");
    expect(sessionStore.compact).toHaveBeenCalled();
  });

  it("does not trigger compact when bridgeSessionStore is not provided", async () => {
    const target = createTarget();
    // No bridgeSessionStore in opts
    const result = await deliverToAgent(target, "hello", { source: "agent-a" });
    expect(result.text).toBe("response");
  });

  it("clears injection flag after successful auto-compact so next message re-injects", async () => {
    const provider = createMockProvider();
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn()
        .mockReturnValueOnce("initial context")      // 1st call — first message injects
        .mockReturnValueOnce("post-compact context"), // 2nd call — after compact cleared flag, re-injects
      needsCompact: vi.fn()
        .mockReturnValueOnce(true)   // after 1st message → trigger compact
        .mockReturnValueOnce(false), // after 2nd message → no compact
      compact: vi.fn(async () => {}), // succeeds → flag cleared
    });
    const target = createTarget(provider);

    // 1st message — context injected + auto-compact triggered → flag cleared
    await deliverToAgent(target, "msg 1", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });
    expect(sessionStore.compact).toHaveBeenCalledTimes(1);

    // 2nd message — flag was cleared by compact, so buildContext is called again
    await deliverToAgent(target, "msg 2", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    // buildContext called twice: 1st msg + 2nd msg (re-injection after compact)
    expect(sessionStore.buildContext).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(provider.sendMessage).mock.calls;
    // calls[0] = 1st user message (with context)
    // calls[1] = 2nd user message (re-injected after compact cleared flag)
    // (compact mock doesn't invoke summariser, so no extra sendMessage call)
    expect(calls[0][0].bridgeSessionContext).toBe("initial context");
    expect(calls[1][0].bridgeSessionContext).toBe("post-compact context");
  });

  it("does NOT clear injection flag when auto-compact fails", async () => {
    const provider = createMockProvider();
    const sessionStore = createMockSessionStore({
      buildContext: vi.fn()
        .mockReturnValueOnce("ctx")
        .mockReturnValueOnce("should not be injected"),
      needsCompact: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
      compact: vi.fn(async () => { throw new Error("fail"); }),
    });
    const target = createTarget(provider);

    // 1st message — compact fails → flag should NOT be cleared
    await deliverToAgent(target, "msg 1", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    // 2nd message — flag still set, so context should NOT be re-injected
    await deliverToAgent(target, "msg 2", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    const calls = vi.mocked(provider.sendMessage).mock.calls;
    // calls[0] = 1st message (with context), calls[1] = 2nd message (no context — flag NOT cleared)
    expect(calls[1][0].bridgeSessionContext).toBeUndefined();
  });

  it("records user and assistant messages in bridgeSessionStore", async () => {
    const sessionStore = createMockSessionStore();
    const target = createTarget();

    await deliverToAgent(target, "hello world", {
      source: "agent-a",
      bridgeSessionStore: sessionStore,
    });

    expect(sessionStore.addUserMessage).toHaveBeenCalledWith(
      "test-agent:default",
      "hello world",
      "agent-a",
      expect.objectContaining({}),
    );
    expect(sessionStore.addAssistantMessage).toHaveBeenCalledWith(
      "test-agent:default",
      "response",
      "test-agent",
      expect.objectContaining({}),
    );
  });
});
