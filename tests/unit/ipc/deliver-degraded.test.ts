import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for deliverToAgent() degraded path:
 * When bridgeSessionStore is NOT provided, sender memories should still be
 * injected via bridgeSessionContext on the first A2A message.
 */

// Mock child_process.execFile so querySenderMemories returns controlled data
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

// Make promisify(execFile) work with our mock
const execFileMock = vi.mocked(execFile);

function setupExecFileMock(memories: Array<{ title?: string; content: string }>) {
  execFileMock.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
    // promisify expects (err, { stdout, stderr }) callback
    const callback = cb ?? _opts;
    if (typeof callback === "function") {
      callback(null, { stdout: JSON.stringify(memories), stderr: "" });
    }
    return {} as any;
  });
}

function makeMockAgent(sendMessageMock: ReturnType<typeof vi.fn>) {
  return {
    name: "test-agent",
    agent: {} as any,
    hudWs: {} as any,
    commandHandler: { handle: vi.fn().mockResolvedValue({ handled: false }) } as any,
    provider: {
      id: "mock",
      type: "mock",
      displayName: "Mock",
      sendMessage: sendMessageMock,
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

describe("deliverToAgent — degraded path (no bridgeSessionStore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("injects sender memories into bridgeSessionContext even without bridgeSessionStore", async () => {
    const { deliverToAgent } = await import("../../../src/ipc/router.js");

    const memories = [
      { title: "Preference", content: "Uses TypeScript" },
      { content: "Works on arinova-bridge" },
    ];
    setupExecFileMock(memories);

    const sendMessageMock = vi.fn().mockResolvedValue({ text: "ok", sessionId: "s1" });
    const agent = makeMockAgent(sendMessageMock);

    // Call WITHOUT bridgeSessionStore — degraded path
    await deliverToAgent(agent, "hello world", { source: "other-agent" });

    // Verify sendMessage was called with bridgeSessionContext containing memories
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const opts = sendMessageMock.mock.calls[0][0];
    expect(opts.bridgeSessionContext).toBeDefined();
    expect(opts.bridgeSessionContext).toContain("Sender memories");
    expect(opts.bridgeSessionContext).toContain("Uses TypeScript");
    expect(opts.bridgeSessionContext).toContain("Works on arinova-bridge");
  });

  it("skips memory query for cli source even without bridgeSessionStore", async () => {
    const { deliverToAgent } = await import("../../../src/ipc/router.js");

    const sendMessageMock = vi.fn().mockResolvedValue({ text: "ok", sessionId: "s1" });
    const agent = makeMockAgent(sendMessageMock);

    await deliverToAgent(agent, "hello", { source: "cli" });

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const opts = sendMessageMock.mock.calls[0][0];
    // CLI source should not have memory injection
    expect(opts.bridgeSessionContext).toBeUndefined();
  });

  it("works normally when memory query returns empty", async () => {
    const { deliverToAgent } = await import("../../../src/ipc/router.js");

    setupExecFileMock([]);

    const sendMessageMock = vi.fn().mockResolvedValue({ text: "ok", sessionId: "s1" });
    const agent = makeMockAgent(sendMessageMock);

    await deliverToAgent(agent, "hello", { source: "other-agent" });

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const opts = sendMessageMock.mock.calls[0][0];
    // Empty memories → no bridgeSessionContext
    expect(opts.bridgeSessionContext).toBeUndefined();
  });
});
