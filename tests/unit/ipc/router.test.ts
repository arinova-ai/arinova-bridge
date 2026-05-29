import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for src/ipc/router.ts — handlers, router dispatch, watch/history,
 * deliverToAgent, querySenderMemories, and runExclusiveOnAgent.
 *
 * Target: bring statement coverage from ~24% to 80%+.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock("../../../src/pipeline/message-pipeline.js", () => ({
  runMessagePipeline: vi.fn().mockResolvedValue({ text: "pipeline-ok" }),
  clearContextInjected: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  createIpcRouter,
  deliverToAgent,
  recordTask,
  notifyWatch,
  subscribeWatch,
  runExclusiveOnAgent,
  type CommandExecutor,
  type IpcHandlerContext,
  type DeliverResult,
} from "../../../src/ipc/router.js";
import type { IpcRequest, IpcResponse, ActiveAgent, TaskRecord } from "../../../src/ipc/types.js";
import type { Provider, SessionListEntry, CostInfo } from "../../../src/providers/types.js";
import type { SpawnManager } from "../../../src/spawn/manager.js";
import type { ForkManager } from "../../../src/fork/manager.js";
import { runMessagePipeline, clearContextInjected } from "../../../src/pipeline/message-pipeline.js";

// ---------------------------------------------------------------------------
// Helpers — mock factories
// ---------------------------------------------------------------------------

function makeMockProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "mock-provider",
    type: "mock",
    displayName: "Mock Provider",
    warmup: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ text: "provider-reply", sessionId: "sid-1" }),
    interrupt: vi.fn(),
    resetSession: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockReturnValue(null),
    getCostInfo: vi.fn().mockReturnValue(null),
    getUsageInfo: vi.fn().mockReturnValue(null),
    listSessions: vi.fn().mockReturnValue([]),
    supportedModels: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setEnv: vi.fn(),
    ...overrides,
  } as Provider;
}

function makeMockAgent(name: string, providerOverrides: Partial<Provider> = {}): ActiveAgent {
  const provider = makeMockProvider(providerOverrides);
  return {
    name,
    agent: { reportToolCall: vi.fn() } as any,
    commandHandler: {
      handle: vi.fn().mockResolvedValue({ handled: false }),
    } as any,
    provider,
    agentConfig: {
      name,
      botToken: "tok",
      provider: "mock",
      cwd: "/workspace",
      model: "test-model",
      compactModel: "compact-model",
      systemPrompt: "You are a helpful agent.",
    },
  };
}

function makeMockExecutor(result?: { stdout: string; stderr: string }): CommandExecutor {
  return {
    execFile: vi.fn().mockResolvedValue(result ?? { stdout: "[]", stderr: "" }),
  };
}

function makeMockSpawnManager(overrides: Partial<SpawnManager> = {}): SpawnManager {
  return {
    spawn: vi.fn().mockReturnValue({
      id: "spawn-1",
      parentAgent: "alice",
      targetAgent: "bob",
      context: "do stuff",
      status: "running",
      result: null,
      createdAt: Date.now(),
      completedAt: null,
      durationMs: null,
      model: null,
      costUsd: null,
    }),
    cancel: vi.fn().mockReturnValue(true),
    listByParent: vi.fn().mockReturnValue([]),
    listAll: vi.fn().mockReturnValue([]),
    getJob: vi.fn().mockReturnValue(null),
    getLogs: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as SpawnManager;
}

function makeMockForkManager(overrides: Partial<ForkManager> = {}): ForkManager {
  return {
    fork: vi.fn().mockReturnValue({
      id: "fork-1",
      parentAgent: "alice",
      task: "my task",
      status: "running",
      result: null,
      createdAt: Date.now(),
      completedAt: null,
      durationMs: null,
      model: null,
    }),
    cancel: vi.fn().mockReturnValue(true),
    listByParent: vi.fn().mockReturnValue([]),
    listAll: vi.fn().mockReturnValue([]),
    getJob: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as ForkManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("router.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // createIpcRouter — dispatch
  // =========================================================================

  describe("createIpcRouter dispatch", () => {
    it("routes list-agents", async () => {
      const alice = makeMockAgent("alice");
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({ id: 1, method: "list-agents" } as IpcRequest);
      expect(res.id).toBe(1);
      expect("result" in res).toBe(true);
      const list = (res as any).result;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("alice");
    });

    it("returns error for unknown method", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({ id: 99, method: "nonexistent" } as any);
      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(-32601);
      expect((res as any).error.message).toContain("Unknown method");
    });

    it("routes watch as immediate ack", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({ id: 10, method: "watch" } as IpcRequest);
      expect((res as any).result.streaming).toBe(true);
    });
  });

  // =========================================================================
  // handleListAgents
  // =========================================================================

  describe("handleListAgents", () => {
    it("returns all agents with provider info", async () => {
      const alice = makeMockAgent("alice");
      const bob = makeMockAgent("bob");
      const router = createIpcRouter([alice, bob], new Map([["mock-provider", alice.provider]]));
      const res = await router({ id: 1, method: "list-agents" } as IpcRequest);
      const list = (res as any).result;
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        name: "alice",
        provider: "mock-provider",
        providerDisplayName: "Mock Provider",
        cwd: "/workspace",
        model: "test-model",
      });
    });

    it("uses 'default' when model is undefined", async () => {
      const agent = makeMockAgent("nomodel");
      agent.agentConfig.model = undefined;
      const router = createIpcRouter([agent], new Map([["mock-provider", agent.provider]]));
      const res = await router({ id: 1, method: "list-agents" } as IpcRequest);
      expect((res as any).result[0].model).toBe("default");
    });
  });

  // =========================================================================
  // handleAgentStatus
  // =========================================================================

  describe("handleAgentStatus", () => {
    it("returns status with sessions", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "mock-provider",
            sessionId: "abcdef123456xyz",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/workspace",
            model: "test-model",
          },
        ] as SessionListEntry[]),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 2,
        method: "agent-status",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.name).toBe("alice");
      expect(result.activeSessions).toBe(1);
      expect(result.sessions[0].sessionId).toBe("abcdef123456");
      expect(result.sessions[0].status).toBe("ready");
    });

    it("returns error when agent not found", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 3,
        method: "agent-status",
        params: { target: "ghost" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(1);
      expect((res as any).error.message).toContain("ghost");
    });

    it("filters sessions to only the target agent", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1s1s1s1s1s1s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
          {
            providerId: "p",
            sessionId: "s2s2s2s2s2s2s2",
            conversationId: "bob:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 4,
        method: "agent-status",
        params: { target: "alice" },
      } as IpcRequest);
      expect((res as any).result.activeSessions).toBe(1);
    });
  });

  // =========================================================================
  // handlePing
  // =========================================================================

  describe("handlePing", () => {
    it("returns alive for existing agent", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 5,
        method: "ping",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.alive).toBe(true);
      expect(result.agent).toBe("alice");
      expect(result.activeSessions).toBe(1);
      expect(result.hasActiveSession).toBe(true);
    });

    it("hasActiveSession is false when all sessions dead", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: false,
            status: "idle",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 6,
        method: "ping",
        params: { target: "alice" },
      } as IpcRequest);
      expect((res as any).result.hasActiveSession).toBe(false);
    });

    it("returns error when agent not found", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 7,
        method: "ping",
        params: { target: "ghost" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
    });
  });

  // =========================================================================
  // handleAgentCost
  // =========================================================================

  describe("handleAgentCost", () => {
    it("returns cost for a specific agent", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
        getCostInfo: vi.fn().mockReturnValue({
          totalCostUsd: 0.05,
          inputTokens: 1000,
          outputTokens: 500,
        } as CostInfo),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 8,
        method: "agent-cost",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.agent).toBe("alice");
      expect(result.totalCostUsd).toBe(0.05);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.sessions).toBe(1);
    });

    it("returns all agents when target is omitted", async () => {
      const alice = makeMockAgent("alice");
      const bob = makeMockAgent("bob");
      const router = createIpcRouter([alice, bob], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 9,
        method: "agent-cost",
        params: {},
      } as IpcRequest);

      const result = (res as any).result;
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it("returns error for nonexistent target agent", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 10,
        method: "agent-cost",
        params: { target: "ghost" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
    });

    it("handles null cost info gracefully", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
        getCostInfo: vi.fn().mockReturnValue(null),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 11,
        method: "agent-cost",
        params: { target: "alice" },
      } as IpcRequest);
      const result = (res as any).result;
      expect(result.totalCostUsd).toBe(0);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    });

    it("aggregates cost across multiple sessions", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
          {
            providerId: "p",
            sessionId: "s2",
            conversationId: "alice:other",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
        getCostInfo: vi
          .fn()
          .mockReturnValueOnce({ totalCostUsd: 0.03, inputTokens: 500, outputTokens: 200 } as CostInfo)
          .mockReturnValueOnce({ totalCostUsd: 0.07, inputTokens: 800, outputTokens: 300 } as CostInfo),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 12,
        method: "agent-cost",
        params: { target: "alice" },
      } as IpcRequest);
      const result = (res as any).result;
      expect(result.totalCostUsd).toBeCloseTo(0.1);
      expect(result.inputTokens).toBe(1300);
      expect(result.outputTokens).toBe(500);
    });
  });

  // =========================================================================
  // handleAgentStop
  // =========================================================================

  describe("handleAgentStop", () => {
    it("interrupts agent sessions", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "busy",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 13,
        method: "agent-stop",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.agent).toBe("alice");
      expect(result.interrupted).toBe(1);
      expect(result.totalSessions).toBe(1);
      expect(alice.provider.interrupt).toHaveBeenCalledWith("alice:default");
    });

    it("returns error when agent not found", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 14,
        method: "agent-stop",
        params: { target: "ghost" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
    });

    it("handles interrupt errors gracefully (best effort)", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "busy",
            cwd: "/",
            model: "m",
          },
          {
            providerId: "p",
            sessionId: "s2",
            conversationId: "alice:other",
            alive: true,
            status: "busy",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
        interrupt: vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("interrupt failed");
          })
          .mockImplementationOnce(() => {}),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 15,
        method: "agent-stop",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      // First interrupt failed, second succeeded
      expect(result.interrupted).toBe(1);
      expect(result.totalSessions).toBe(2);
    });
  });

  // =========================================================================
  // handleAgentReset
  // =========================================================================

  describe("handleAgentReset", () => {
    it("resets agent sessions and clears context", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 16,
        method: "agent-reset",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.agent).toBe("alice");
      expect(result.reset).toBe(1);
      expect(result.totalSessions).toBe(1);
      expect(alice.provider.resetSession).toHaveBeenCalledWith("alice:default", { restartProcess: true });
      expect(clearContextInjected).toHaveBeenCalledWith("alice:default");
    });

    it("returns error when agent not found", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 17,
        method: "agent-reset",
        params: { target: "ghost" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
    });

    it("handles reset errors gracefully (best effort)", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/",
            model: "m",
          },
        ] as SessionListEntry[]),
        resetSession: vi.fn().mockRejectedValue(new Error("reset failed")),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 18,
        method: "agent-reset",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.reset).toBe(0);
      expect(result.totalSessions).toBe(1);
    });
  });

  // =========================================================================
  // handleHandoff
  // =========================================================================

  describe("handleHandoff", () => {
    it("returns handoff info between two agents", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/project",
            model: "gpt-4",
          },
        ] as SessionListEntry[]),
      });
      const bob = makeMockAgent("bob");
      const router = createIpcRouter([alice, bob], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 19,
        method: "handoff",
        params: { from: "alice", to: "bob" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.from).toBe("alice");
      expect(result.to).toBe("bob");
      expect(result.cwd).toBe("/project");
      expect(result.sessionCount).toBe(1);
    });

    it("returns error when from agent not found", async () => {
      const bob = makeMockAgent("bob");
      const router = createIpcRouter([bob], new Map([["mock-provider", bob.provider]]));
      const res = await router({
        id: 20,
        method: "handoff",
        params: { from: "ghost", to: "bob" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
      expect((res as any).error.message).toContain("ghost");
    });

    it("returns error when to agent not found", async () => {
      const alice = makeMockAgent("alice");
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 21,
        method: "handoff",
        params: { from: "alice", to: "ghost" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
      expect((res as any).error.message).toContain("ghost");
    });

    it("returns error when from and to are the same", async () => {
      const alice = makeMockAgent("alice");
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 22,
        method: "handoff",
        params: { from: "alice", to: "alice" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(3);
      expect((res as any).error.message).toContain("same agent");
    });

    it("returns error when from agent has no sessions", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([]),
      });
      const bob = makeMockAgent("bob");
      const router = createIpcRouter([alice, bob], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 23,
        method: "handoff",
        params: { from: "alice", to: "bob" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(4);
    });

    it("uses agent config cwd as fallback when session has no cwd", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "",
            model: "m",
          },
        ] as SessionListEntry[]),
      });
      const bob = makeMockAgent("bob");
      const router = createIpcRouter([alice, bob], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 24,
        method: "handoff",
        params: { from: "alice", to: "bob" },
      } as IpcRequest);
      const result = (res as any).result;
      // cwd should fallback to agentConfig.cwd
      expect(result.cwd).toBe("/workspace");
    });

    it("uses target agent model default when session model is undefined", async () => {
      const alice = makeMockAgent("alice", {
        listSessions: vi.fn().mockReturnValue([
          {
            providerId: "p",
            sessionId: "s1",
            conversationId: "alice:default",
            alive: true,
            status: "ready",
            cwd: "/proj",
          },
        ] as SessionListEntry[]),
      });
      const bob = makeMockAgent("bob");
      bob.agentConfig.model = undefined;
      const router = createIpcRouter([alice, bob], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 25,
        method: "handoff",
        params: { from: "alice", to: "bob" },
      } as IpcRequest);
      const result = (res as any).result;
      expect(result.model).toBe("default");
    });
  });

  // =========================================================================
  // handleHistory
  // =========================================================================

  describe("handleHistory", () => {
    it("returns task history", async () => {
      // Record some tasks first
      recordTask({
        agent: "alice",
        content: "hello",
        responsePreview: "hi there",
        durationMs: 100,
        timestamp: Date.now(),
      });
      recordTask({
        agent: "bob",
        content: "test",
        responsePreview: "ok",
        durationMs: 50,
        timestamp: Date.now(),
      });

      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 26,
        method: "history",
        params: {},
      } as IpcRequest);

      const result = (res as any).result;
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by target agent", async () => {
      recordTask({
        agent: "alice",
        content: "specific",
        responsePreview: "specific-reply",
        durationMs: 100,
        timestamp: Date.now(),
      });

      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 27,
        method: "history",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      for (const r of result) {
        expect(r.agent.toLowerCase()).toBe("alice");
      }
    });

    it("respects limit parameter", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 28,
        method: "history",
        params: { limit: 1 },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it("case-insensitive target filter", async () => {
      recordTask({
        agent: "Alice",
        content: "cs",
        responsePreview: "cs-reply",
        durationMs: 100,
        timestamp: Date.now(),
      });

      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 29,
        method: "history",
        params: { target: "alice" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.some((r: any) => r.agent === "Alice")).toBe(true);
    });
  });

  // =========================================================================
  // handleDeliver (via createIpcRouter)
  // =========================================================================

  describe("handleDeliver", () => {
    it("returns error when target agent not found", async () => {
      const router = createIpcRouter([], new Map());
      const res = await router({
        id: 30,
        method: "deliver",
        params: { target: "ghost", content: "hello" },
      } as IpcRequest);
      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(1);
    });

    it("handles command path (handled = true)", async () => {
      const alice = makeMockAgent("alice");
      (alice.commandHandler.handle as any).mockResolvedValue({ handled: true });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 31,
        method: "deliver",
        params: { target: "alice", content: "/status" },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.agent).toBe("alice");
      expect(typeof result.durationMs).toBe("number");
    });

    it("fire-and-forget returns queued immediately", async () => {
      const alice = makeMockAgent("alice");
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 32,
        method: "deliver",
        params: { target: "alice", content: "hello", wait: false },
      } as IpcRequest);

      const result = (res as any).result;
      expect(result.queued).toBe(true);
      expect(result.agent).toBe("alice");
    });

    it("returns error when deliverToAgent throws", async () => {
      const alice = makeMockAgent("alice", {
        sendMessage: vi.fn().mockRejectedValue(new Error("provider down")),
      });
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 33,
        method: "deliver",
        params: { target: "alice", content: "hello" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(2);
    });

    it("case-insensitive agent lookup", async () => {
      const alice = makeMockAgent("Alice");
      const router = createIpcRouter([alice], new Map([["mock-provider", alice.provider]]));
      const res = await router({
        id: 34,
        method: "deliver",
        params: { target: "alice", content: "/status" },
      } as IpcRequest);
      // Should not error out - found via case-insensitive match
      expect("error" in res && (res as any).error.code === 1).toBe(false);
    });
  });

  // =========================================================================
  // Spawn Handlers
  // =========================================================================

  describe("spawn handlers", () => {
    describe("spawn-add", () => {
      it("creates a spawn job", async () => {
        const alice = makeMockAgent("alice");
        const bob = makeMockAgent("bob");
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([alice, bob], new Map(), undefined, sm);
        const res = await router({
          id: 40,
          method: "spawn-add",
          params: { parentAgent: "alice", targetAgent: "bob", context: "do stuff" },
        } as IpcRequest);

        const result = (res as any).result;
        expect(result.id).toBe("spawn-1");
        expect(result.parentAgent).toBe("alice");
        expect(result.targetAgent).toBe("bob");
        expect(result.status).toBe("running");
      });

      it("returns error when spawn manager not enabled", async () => {
        const alice = makeMockAgent("alice");
        const router = createIpcRouter([alice], new Map());
        const res = await router({
          id: 41,
          method: "spawn-add",
          params: { parentAgent: "alice", targetAgent: "bob", context: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when parent agent not found", async () => {
        const bob = makeMockAgent("bob");
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([bob], new Map(), undefined, sm);
        const res = await router({
          id: 42,
          method: "spawn-add",
          params: { parentAgent: "ghost", targetAgent: "bob", context: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(1);
      });

      it("returns error when target agent not found", async () => {
        const alice = makeMockAgent("alice");
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([alice], new Map(), undefined, sm);
        const res = await router({
          id: 43,
          method: "spawn-add",
          params: { parentAgent: "alice", targetAgent: "ghost", context: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(1);
      });

      it("returns error when spawn manager throws", async () => {
        const alice = makeMockAgent("alice");
        const bob = makeMockAgent("bob");
        const sm = makeMockSpawnManager({
          spawn: vi.fn().mockImplementation(() => {
            throw new Error("limit reached");
          }),
        });
        const router = createIpcRouter([alice, bob], new Map(), undefined, sm);
        const res = await router({
          id: 44,
          method: "spawn-add",
          params: { parentAgent: "alice", targetAgent: "bob", context: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(10);
      });
    });

    describe("spawn-list", () => {
      it("lists all spawn jobs", async () => {
        const sm = makeMockSpawnManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "s1",
              parentAgent: "alice",
              targetAgent: "bob",
              context: "task",
              status: "completed",
              result: "done",
              createdAt: Date.now(),
              completedAt: Date.now(),
              durationMs: 500,
              model: "m",
              costUsd: 0.01,
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 45,
          method: "spawn-list",
          params: {},
        } as IpcRequest);

        const result = (res as any).result;
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("s1");
      });

      it("filters by parent agent", async () => {
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([], new Map(), undefined, sm);
        await router({
          id: 46,
          method: "spawn-list",
          params: { agent: "alice" },
        } as IpcRequest);
        expect(sm.listByParent).toHaveBeenCalledWith("alice");
      });

      it("returns error when spawn manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 47,
          method: "spawn-list",
          params: {},
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("formats result preview with truncation for multi-line results", async () => {
        const multiLineResult = "first line\nsecond line\nthird line";
        const sm = makeMockSpawnManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "s1",
              parentAgent: "alice",
              targetAgent: "bob",
              context: "task",
              status: "completed",
              result: multiLineResult,
              createdAt: Date.now(),
              completedAt: Date.now(),
              durationMs: 500,
              model: "m",
              costUsd: 0.01,
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 48,
          method: "spawn-list",
          params: {},
        } as IpcRequest);

        const result = (res as any).result;
        // Multi-line result: firstLine is shorter than full result, so truncated=true
        expect(result[0].resultPreview).toContain("chars");
      });

      it("formats result preview with truncation for long single-line results", async () => {
        const longResult = "A".repeat(200);
        const sm = makeMockSpawnManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "s1",
              parentAgent: "alice",
              targetAgent: "bob",
              context: "task",
              status: "completed",
              result: longResult,
              createdAt: Date.now(),
              completedAt: Date.now(),
              durationMs: 500,
              model: "m",
              costUsd: 0.01,
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 481,
          method: "spawn-list",
          params: {},
        } as IpcRequest);

        const result = (res as any).result;
        expect(result[0].resultPreview).toContain("chars");
      });

      it("shows null resultPreview when result is null", async () => {
        const sm = makeMockSpawnManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "s1",
              parentAgent: "alice",
              targetAgent: "bob",
              context: "task",
              status: "running",
              result: null,
              createdAt: Date.now(),
              completedAt: null,
              durationMs: null,
              model: null,
              costUsd: null,
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 49,
          method: "spawn-list",
          params: {},
        } as IpcRequest);
        expect((res as any).result[0].resultPreview).toBeNull();
      });

      it("shows short result without truncation marker", async () => {
        const sm = makeMockSpawnManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "s1",
              parentAgent: "alice",
              targetAgent: "bob",
              context: "task",
              status: "completed",
              result: "short result",
              createdAt: Date.now(),
              completedAt: Date.now(),
              durationMs: 500,
              model: "m",
              costUsd: 0.01,
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 50,
          method: "spawn-list",
          params: {},
        } as IpcRequest);
        const preview = (res as any).result[0].resultPreview;
        expect(preview).toBe("short result");
        expect(preview).not.toContain("chars");
      });
    });

    describe("spawn-cancel", () => {
      it("cancels a spawn job", async () => {
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 51,
          method: "spawn-cancel",
          params: { id: "spawn-1" },
        } as IpcRequest);

        expect((res as any).result.cancelled).toBe(true);
      });

      it("returns error when spawn manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 52,
          method: "spawn-cancel",
          params: { id: "spawn-1" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when job not found or already completed", async () => {
        const sm = makeMockSpawnManager({
          cancel: vi.fn().mockReturnValue(false),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 53,
          method: "spawn-cancel",
          params: { id: "bad-id" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(11);
      });
    });

    describe("spawn-result", () => {
      it("returns full spawn result", async () => {
        const sm = makeMockSpawnManager({
          getJob: vi.fn().mockReturnValue({
            id: "s1",
            parentAgent: "alice",
            targetAgent: "bob",
            context: "task",
            status: "completed",
            result: "done",
            createdAt: Date.now(),
            completedAt: Date.now(),
            durationMs: 500,
            model: "m",
            costUsd: 0.01,
          }),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 54,
          method: "spawn-result",
          params: { id: "s1" },
        } as IpcRequest);

        const result = (res as any).result;
        expect(result.id).toBe("s1");
        expect(result.result).toBe("done");
      });

      it("returns error when spawn manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 55,
          method: "spawn-result",
          params: { id: "s1" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when job not found", async () => {
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 56,
          method: "spawn-result",
          params: { id: "nonexistent" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(11);
      });
    });

    describe("spawn-logs", () => {
      it("returns logs for a spawn job", async () => {
        const sm = makeMockSpawnManager({
          getJob: vi.fn().mockReturnValue({
            id: "s1",
            parentAgent: "alice",
            targetAgent: "bob",
            context: "task",
            status: "running",
            result: null,
            createdAt: Date.now(),
            completedAt: null,
            durationMs: null,
            model: null,
            costUsd: null,
          }),
          getLogs: vi.fn().mockReturnValue([
            { content: "log line 1", createdAt: Date.now() },
            { content: "log line 2", createdAt: Date.now() },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 57,
          method: "spawn-logs",
          params: { id: "s1" },
        } as IpcRequest);

        const result = (res as any).result;
        expect(result.id).toBe("s1");
        expect(result.logs).toHaveLength(2);
      });

      it("returns error when spawn manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 58,
          method: "spawn-logs",
          params: { id: "s1" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when job not found", async () => {
        const sm = makeMockSpawnManager();
        const router = createIpcRouter([], new Map(), undefined, sm);
        const res = await router({
          id: 59,
          method: "spawn-logs",
          params: { id: "nonexistent" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(11);
      });
    });
  });

  // =========================================================================
  // Fork Handlers
  // =========================================================================

  describe("fork handlers", () => {
    describe("fork-add", () => {
      it("creates a fork job", async () => {
        const alice = makeMockAgent("alice");
        const fm = makeMockForkManager();
        const router = createIpcRouter([alice], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 60,
          method: "fork-add",
          params: { agent: "alice", task: "my task" },
        } as IpcRequest);

        const result = (res as any).result;
        expect(result.id).toBe("fork-1");
        expect(result.parentAgent).toBe("alice");
        expect(result.status).toBe("running");
      });

      it("returns error when fork manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 61,
          method: "fork-add",
          params: { agent: "alice", task: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when agent not found", async () => {
        const fm = makeMockForkManager();
        const router = createIpcRouter([], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 62,
          method: "fork-add",
          params: { agent: "ghost", task: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(1);
      });

      it("returns error when fork manager throws", async () => {
        const alice = makeMockAgent("alice");
        const fm = makeMockForkManager({
          fork: vi.fn().mockImplementation(() => {
            throw new Error("fork limit");
          }),
        });
        const router = createIpcRouter([alice], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 63,
          method: "fork-add",
          params: { agent: "alice", task: "x" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(12);
      });
    });

    describe("fork-list", () => {
      it("lists all fork jobs", async () => {
        const fm = makeMockForkManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "f1",
              parentAgent: "alice",
              task: "do stuff",
              status: "completed",
              result: "done",
              createdAt: Date.now(),
              completedAt: Date.now(),
              durationMs: 200,
              model: "m",
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 64,
          method: "fork-list",
          params: {},
        } as IpcRequest);

        const result = (res as any).result;
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("f1");
        expect(result[0].resultPreview).toBeDefined();
      });

      it("filters by agent name", async () => {
        const alice = makeMockAgent("alice");
        const fm = makeMockForkManager();
        const router = createIpcRouter([alice], new Map(), undefined, undefined, fm);
        await router({
          id: 65,
          method: "fork-list",
          params: { agent: "alice" },
        } as IpcRequest);
        expect(fm.listByParent).toHaveBeenCalledWith("alice");
      });

      it("returns error when fork manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 66,
          method: "fork-list",
          params: {},
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when agent not found for filtered list", async () => {
        const fm = makeMockForkManager();
        const router = createIpcRouter([], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 67,
          method: "fork-list",
          params: { agent: "ghost" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(1);
      });

      it("shows null resultPreview when result is null", async () => {
        const fm = makeMockForkManager({
          listAll: vi.fn().mockReturnValue([
            {
              id: "f1",
              parentAgent: "alice",
              task: "do stuff",
              status: "running",
              result: null,
              createdAt: Date.now(),
              completedAt: null,
              durationMs: null,
              model: null,
            },
          ]),
        });
        const router = createIpcRouter([], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 68,
          method: "fork-list",
          params: {},
        } as IpcRequest);
        expect((res as any).result[0].resultPreview).toBeNull();
      });
    });

    describe("fork-cancel", () => {
      it("cancels a fork job", async () => {
        const fm = makeMockForkManager();
        const router = createIpcRouter([], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 69,
          method: "fork-cancel",
          params: { id: "fork-1" },
        } as IpcRequest);
        expect((res as any).result.cancelled).toBe(true);
      });

      it("returns error when fork manager not enabled", async () => {
        const router = createIpcRouter([], new Map());
        const res = await router({
          id: 70,
          method: "fork-cancel",
          params: { id: "fork-1" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(5);
      });

      it("returns error when job not found or already completed", async () => {
        const fm = makeMockForkManager({
          cancel: vi.fn().mockReturnValue(false),
        });
        const router = createIpcRouter([], new Map(), undefined, undefined, fm);
        const res = await router({
          id: 71,
          method: "fork-cancel",
          params: { id: "bad-id" },
        } as IpcRequest);
        expect("error" in res).toBe(true);
        expect((res as any).error.code).toBe(13);
      });
    });
  });

  // =========================================================================
  // deliverToAgent — direct unit tests
  // =========================================================================

  describe("deliverToAgent", () => {
    it("returns response when command handler handles the message", async () => {
      const alice = makeMockAgent("alice");
      (alice.commandHandler.handle as any).mockImplementation(async (_content: string, ctx: any) => {
        ctx.sendComplete("command result");
        return { handled: true };
      });
      const result = await deliverToAgent(alice, "/help");
      expect(result.text).toBe("command result");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("throws on A2A recursion limit", async () => {
      const alice = makeMockAgent("alice");
      await expect(deliverToAgent(alice, "hello", { sourceConversationId: "a2a:1:test" })).rejects.toThrow(
        "A2A recursion limit reached",
      );
    });

    it("does NOT throw when depth is 0", async () => {
      const alice = makeMockAgent("alice");
      const result = await deliverToAgent(alice, "/status");
      expect(result).toBeDefined();
    });

    it("uses lightweight path when no bridgeSessionStore", async () => {
      const alice = makeMockAgent("alice");
      const sendMsg = alice.provider.sendMessage as any;
      sendMsg.mockResolvedValue({ text: "lightweight-reply", sessionId: "s1" });

      const result = await deliverToAgent(alice, "hello world");
      expect(result.text).toBe("lightweight-reply");
      expect(sendMsg).toHaveBeenCalled();
    });

    it("uses pipeline path when bridgeSessionStore provided", async () => {
      const alice = makeMockAgent("alice");
      const mockStore = {} as any;
      vi.mocked(runMessagePipeline).mockResolvedValue({ text: "pipeline-result" } as any);

      const result = await deliverToAgent(alice, "hello", { bridgeSessionStore: mockStore });
      expect(result.text).toBe("pipeline-result");
      expect(runMessagePipeline).toHaveBeenCalled();
    });

    it("passes executor to querySenderMemories", async () => {
      const alice = makeMockAgent("alice");
      const executor = makeMockExecutor({
        stdout: JSON.stringify([{ content: "memory item" }]),
        stderr: "",
      });

      await deliverToAgent(alice, "hello", { source: "bob", executor });
      // Should have called executor.execFile for memory query
      expect(executor.execFile).toHaveBeenCalled();
    });

    it("skips memory query for cli source", async () => {
      const alice = makeMockAgent("alice");
      const executor = makeMockExecutor();

      await deliverToAgent(alice, "hello", { source: "cli", executor });
      expect(executor.execFile).not.toHaveBeenCalled();
    });

    it("handles sendChunk accumulation in command handler path", async () => {
      const alice = makeMockAgent("alice");
      (alice.commandHandler.handle as any).mockImplementation(async (_content: string, ctx: any) => {
        ctx.sendChunk("chunk1");
        ctx.sendChunk("chunk2");
        return { handled: true };
      });
      const result = await deliverToAgent(alice, "/help");
      expect(result.text).toBe("chunk1chunk2");
    });

    it("handles sendError in command handler path", async () => {
      const alice = makeMockAgent("alice");
      (alice.commandHandler.handle as any).mockImplementation(async (_content: string, ctx: any) => {
        ctx.sendError("something went wrong");
        return { handled: true };
      });
      const result = await deliverToAgent(alice, "/bad");
      expect(result.text).toBe("Error: something went wrong");
    });

    it("uses default source 'cli' when not provided", async () => {
      const alice = makeMockAgent("alice");
      const executor = makeMockExecutor();
      // Should not query memories when source defaults to cli
      await deliverToAgent(alice, "hello", { executor });
      expect(executor.execFile).not.toHaveBeenCalled();
    });

    it("uses agent cwd and model defaults", async () => {
      const alice = makeMockAgent("alice");
      const sendMsg = alice.provider.sendMessage as any;
      sendMsg.mockResolvedValue({ text: "ok", sessionId: "s1" });

      await deliverToAgent(alice, "hello");
      const call = sendMsg.mock.calls[0][0];
      expect(call.cwd).toBe("/workspace");
      expect(call.model).toBe("test-model");
    });

    it("overrides cwd and model from opts", async () => {
      const alice = makeMockAgent("alice");
      const sendMsg = alice.provider.sendMessage as any;
      sendMsg.mockResolvedValue({ text: "ok", sessionId: "s1" });

      await deliverToAgent(alice, "hello", { cwd: "/custom", model: "custom-model" });
      const call = sendMsg.mock.calls[0][0];
      expect(call.cwd).toBe("/custom");
      expect(call.model).toBe("custom-model");
    });

    it("calls onLog callback during provider message", async () => {
      const alice = makeMockAgent("alice");
      const sendMsg = alice.provider.sendMessage as any;
      sendMsg.mockImplementation(async (opts: any) => {
        opts.onChunk("streaming...");
        return { text: "final", sessionId: "s1" };
      });
      const logs: string[] = [];
      await deliverToAgent(alice, "hello", { onLog: (t) => logs.push(t) });
      expect(logs).toContain("streaming...");
    });
  });

  // =========================================================================
  // Watch / notifyWatch / subscribeWatch
  // =========================================================================

  describe("watch and notifyWatch", () => {
    it("subscribeWatch adds a subscriber and returns unsubscribe", () => {
      const lines: string[] = [];
      const unsub = subscribeWatch((line) => lines.push(line));

      const record: TaskRecord = {
        agent: "alice",
        content: "test",
        responsePreview: "ok",
        durationMs: 100,
        timestamp: Date.now(),
      };
      notifyWatch(record);

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.agent).toBe("alice");

      unsub();
      notifyWatch(record);
      // Should not receive after unsubscribe
      expect(lines).toHaveLength(1);
    });

    it("notifyWatch handles subscriber errors gracefully", () => {
      const unsub = subscribeWatch(() => {
        throw new Error("subscriber error");
      });
      const record: TaskRecord = {
        agent: "alice",
        content: "test",
        responsePreview: "ok",
        durationMs: 100,
        timestamp: Date.now(),
      };
      // Should not throw
      expect(() => notifyWatch(record)).not.toThrow();
      unsub();
    });
  });

  // =========================================================================
  // recordTask
  // =========================================================================

  describe("recordTask", () => {
    it("records tasks and notifies watch subscribers", () => {
      const lines: string[] = [];
      const unsub = subscribeWatch((line) => lines.push(line));

      recordTask({
        agent: "alice",
        content: "hello",
        responsePreview: "hi",
        durationMs: 50,
        timestamp: Date.now(),
      });

      expect(lines.length).toBeGreaterThanOrEqual(1);
      unsub();
    });
  });

  // =========================================================================
  // runExclusiveOnAgent
  // =========================================================================

  describe("runExclusiveOnAgent", () => {
    it("serializes calls for the same agent", async () => {
      const order: number[] = [];

      const p1 = runExclusiveOnAgent("alice-serial", async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
        return 1;
      });

      const p2 = runExclusiveOnAgent("alice-serial", async () => {
        order.push(2);
        return 2;
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(order).toEqual([1, 2]);
    });

    it("allows parallel calls for different agents", async () => {
      const order: string[] = [];

      const p1 = runExclusiveOnAgent("alice-par", async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push("alice");
      });

      const p2 = runExclusiveOnAgent("bob-par", async () => {
        order.push("bob");
      });

      await Promise.all([p1, p2]);
      // bob should finish before alice because alice sleeps
      expect(order[0]).toBe("bob");
    });

    it("continues chain even when a function rejects", async () => {
      const p1 = runExclusiveOnAgent("err-agent", async () => {
        throw new Error("fail");
      });
      await expect(p1).rejects.toThrow("fail");

      // Subsequent call should still work
      const p2 = runExclusiveOnAgent("err-agent", async () => "recovered");
      await expect(p2).resolves.toBe("recovered");
    });
  });

  // =========================================================================
  // querySenderMemories (tested via deliverToAgent integration)
  // =========================================================================

  describe("querySenderMemories via deliverToAgent", () => {
    it("injects sender memories into pipeline path", async () => {
      const alice = makeMockAgent("alice");
      const mockStore = {} as any;
      const executor = makeMockExecutor({
        stdout: JSON.stringify([{ title: "Pref", content: "Uses TS" }, { content: "Likes tests" }]),
        stderr: "",
      });

      vi.mocked(runMessagePipeline).mockResolvedValue({ text: "pipeline-ok" } as any);

      await deliverToAgent(alice, "hello", {
        source: "bob",
        bridgeSessionStore: mockStore,
        executor,
      });

      expect(executor.execFile).toHaveBeenCalled();
      const pipelineCall = vi.mocked(runMessagePipeline).mock.calls[0][0];
      expect(pipelineCall.extraContext).toContain("Sender memories");
      expect(pipelineCall.extraContext).toContain("Uses TS");
      expect(pipelineCall.senderName).toBe("bob");
    });

    it("skips memory query for spawn source", async () => {
      const alice = makeMockAgent("alice");
      const executor = makeMockExecutor();

      await deliverToAgent(alice, "hello", { source: "spawn:123", executor });
      expect(executor.execFile).not.toHaveBeenCalled();
    });

    it("skips memory query for fork source", async () => {
      const alice = makeMockAgent("alice");
      const executor = makeMockExecutor();

      await deliverToAgent(alice, "hello", { source: "fork:456", executor });
      expect(executor.execFile).not.toHaveBeenCalled();
    });

    it("handles memory query failure gracefully", async () => {
      const alice = makeMockAgent("alice");
      const executor: CommandExecutor = {
        execFile: vi.fn().mockRejectedValue(new Error("command not found")),
      };

      // Should not throw
      const result = await deliverToAgent(alice, "hello", { source: "bob", executor });
      expect(result).toBeDefined();
    });

    it("injects memories into bridgeSessionContext on lightweight path", async () => {
      const alice = makeMockAgent("alice");
      const executor = makeMockExecutor({
        stdout: JSON.stringify([{ content: "memory item" }]),
        stderr: "",
      });
      const sendMsg = alice.provider.sendMessage as any;
      sendMsg.mockResolvedValue({ text: "ok", sessionId: "s1" });

      await deliverToAgent(alice, "hello", { source: "bob", executor });

      const call = sendMsg.mock.calls[0][0];
      expect(call.bridgeSessionContext).toContain("Sender memories");
      expect(call.bridgeSessionContext).toContain("memory item");
    });
  });
});
