import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: the Inspector tracker entry is created only for the provider
 * phase, not the command-handler phase. Otherwise cancel-delivery would
 * remove the entry and report "success" while a synchronous command handler
 * kept running uncancelled — a contract lie. While the handler runs, snapshot
 * must show no row and cancel must return "not_found".
 */

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

function makeMockAgent(commandHandle: any, sendMessage = vi.fn().mockResolvedValue({ text: "ok", sessionId: "s1" })) {
  return {
    name: "test-agent",
    agent: {} as any,
    commandHandler: { handle: commandHandle } as any,
    provider: {
      id: "mock",
      type: "mock",
      displayName: "Mock",
      sendMessage,
      async resetSession() {},
      async resumeSession() { return true; },
      getSessionInfo() { return null; },
      listSessions() { return []; },
      interrupt() {},
      getCostInfo() { return null; },
      getUsageInfo() { return null; },
      supportedModels() { return []; },
      async shutdown() {},
      setEnv() {},
    } as any,
    agentConfig: { name: "test-agent", cwd: "/tmp", provider: "mock" } as any,
  };
}

describe("deliverToAgent — tracker visibility", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("command-handler-phase delivery is NOT visible in snapshot, cancel returns not_found", async () => {
    const { deliverToAgent } = await import("../../../src/ipc/router.js");
    const { activeDeliveries } = await import("../../../src/ipc/deliveries.js");
    activeDeliveries.reset();

    // Handler that blocks indefinitely while we observe state. We probe the
    // tracker mid-flight, then release the handler so the test can return.
    let release: (v: any) => void = () => {};
    const released = new Promise((r) => { release = r; });
    const handle = vi.fn().mockImplementation(async () => {
      await released;
      return { handled: true };
    });

    const deliverPromise = deliverToAgent(makeMockAgent(handle) as any, "hi", { source: "lucy" });

    // Yield so deliverToAgent has actually entered commandHandler.handle().
    await new Promise((r) => setImmediate(r));

    // During the command-handler phase: no tracker row, cancel returns not_found.
    expect(activeDeliveries.snapshot()).toHaveLength(0);
    expect(activeDeliveries.cancel("any-id-at-all")).toBe("not_found");

    release({ handled: true });
    await deliverPromise;
  });

  it("provider-phase delivery IS visible, populates source/target via opts UUID fallback", async () => {
    const { deliverToAgent } = await import("../../../src/ipc/router.js");
    const { activeDeliveries } = await import("../../../src/ipc/deliveries.js");
    activeDeliveries.reset();

    // Handler immediately defers — that's how deliverToAgent reaches the
    // provider phase. We then block the provider so we can snapshot mid-flight.
    const handle = vi.fn().mockResolvedValue({ handled: false });
    let releaseProvider: (v: any) => void = () => {};
    const providerBarrier = new Promise((r) => { releaseProvider = r; });
    const sendMessage = vi.fn().mockImplementation(async () => {
      await providerBarrier;
      return { text: "ok", sessionId: "s1" };
    });

    const sourceUuid = "9c5e0d8b-1234-4abc-9def-0123456789ab";
    const targetUuid = "1a2b3c4d-5678-4abc-9def-fedcba987654";

    const agent = makeMockAgent(handle, sendMessage);
    // source: "cli" skips the sender-memory subprocess query so the test
    // doesn't depend on an execFile mock; the UUID opts still flow through.
    const deliverPromise = deliverToAgent(agent as any, "hi", {
      source: "cli",
      sourceAgentId: sourceUuid,
      targetAgentId: targetUuid,
    });

    // Yield repeatedly until the provider path has been entered and acked.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const snap = activeDeliveries.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].source_agent_id).toBe(sourceUuid);
    expect(snap[0].target_agent_id).toBe(targetUuid);
    expect(snap[0].acked_at).not.toBeNull();

    releaseProvider({ text: "ok", sessionId: "s1" });
    await deliverPromise;
    expect(activeDeliveries.snapshot()).toHaveLength(0);
  });

  it("falls back to source string when caller omits UUID (spawn/fork path)", async () => {
    const { deliverToAgent } = await import("../../../src/ipc/router.js");
    const { activeDeliveries } = await import("../../../src/ipc/deliveries.js");
    activeDeliveries.reset();

    const handle = vi.fn().mockResolvedValue({ handled: false });
    let releaseProvider: (v: any) => void = () => {};
    const providerBarrier = new Promise((r) => { releaseProvider = r; });
    const sendMessage = vi.fn().mockImplementation(async () => {
      await providerBarrier;
      return { text: "ok", sessionId: "s1" };
    });

    const agent = makeMockAgent(handle, sendMessage);
    const deliverPromise = deliverToAgent(agent as any, "hi", { source: "spawn:job-abc-123" });

    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const snap = activeDeliveries.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].source_agent_id).toBe("spawn:job-abc-123");
    expect(snap[0].target_agent_id).toBe("test-agent");

    releaseProvider({ text: "ok", sessionId: "s1" });
    await deliverPromise;
  });
});
