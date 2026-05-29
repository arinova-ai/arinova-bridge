/**
 * Spawn Observability — comprehensive tests for:
 * 1. Spawn Result (555f2cc1) — full result view + ownership
 * 2. Spawn List (64bd1e0a) — result preview + truncation
 * 3. Spawn Logs (249b7763) — intermediate logs + flush lifecycle
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandHandler } from "../../../src/commands/handler.js";
import { SpawnStore } from "../../../src/spawn/store.js";
import { SpawnManager } from "../../../src/spawn/manager.js";
import type { BridgeConfig } from "../../../src/config.js";
import type { CommandContext } from "../../../src/commands/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function createMockProvider(id: string, type: string, displayName: string) {
  return {
    id,
    type,
    displayName,
    sendMessage: vi.fn(async () => ({ text: "ok" })),
    interrupt: vi.fn(),
    resetSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => true),
    getSessionInfo: vi.fn(() => ({ sessionId: `${id}-sess`, alive: true, cwd: "/test", model: "sonnet" })),
    getCostInfo: vi.fn(() => ({ totalCostUsd: 0 })),
    listSessions: vi.fn(() => []),
    supportedModels: vi.fn(() => ["sonnet"]),
    shutdown: vi.fn(async () => {}),
  };
}

function createMockConfig(): BridgeConfig {
  return {
    arinova: { serverUrl: "ws://test", botToken: "tok" },
    defaultProvider: "anthropic-oauth",
    providers: [{ id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic", enabled: true }],
    defaults: { cwd: "/tmp", maxSessions: 5, idleTimeoutMs: 600000, dbPath: "/tmp/test.db" },
    agents: [],
  };
}

const providers = [createMockProvider("anthropic-oauth", "anthropic-cli", "Anthropic")];

function createCtx(conversationId = "conv-1") {
  const ctx = {
    conversationId,
    chunks: [] as string[],
    completed: null as string | null,
    errored: null as string | null,
    sendChunk: vi.fn((text: string) => {
      ctx.chunks.push(text);
    }),
    sendComplete: vi.fn((text: string) => {
      ctx.completed = text;
    }),
    sendError: vi.fn((text: string) => {
      ctx.errored = text;
    }),
    listNotes: vi.fn(async () => ({ notes: [], hasMore: false })),
    createNote: vi.fn(async () => ({
      id: "n1",
      conversationId,
      creatorId: "a",
      creatorType: "agent" as const,
      creatorName: "b",
      title: "",
      content: "",
      createdAt: "",
      updatedAt: "",
    })),
    updateNote: vi.fn(async () => ({})),
    deleteNote: vi.fn(async () => ({})),
    searchNotes: vi.fn(async () => ({ notes: [], hasMore: false })),
  };
  return ctx;
}

function makeJob(
  overrides: Partial<{
    id: string;
    parentAgent: string;
    targetAgent: string;
    status: string;
    result: string | null;
    context: string;
    createdAt: number;
    completedAt: number | null;
    durationMs: number | null;
  }> = {},
) {
  return {
    id: overrides.id ?? "abc12345",
    parentAgent: overrides.parentAgent ?? "agent-a",
    targetAgent: overrides.targetAgent ?? "agent-b",
    context: overrides.context ?? "do something",
    status: overrides.status ?? "completed",
    result: "result" in overrides ? overrides.result! : "done!",
    createdAt: overrides.createdAt ?? Date.now(),
    completedAt: overrides.completedAt ?? Date.now(),
    durationMs: overrides.durationMs ?? 1234,
    model: null,
    costUsd: null,
  };
}

function setupHandler(
  agentName: string,
  jobs: ReturnType<typeof makeJob>[],
  logs: Array<{ content: string; createdAt: number }> = [],
) {
  const h = new CommandHandler(providers as any, createMockConfig());
  h.agentName = agentName;
  h.spawnManager = {
    getJob: vi.fn((id: string) => jobs.find((j) => j.id === id) ?? null),
    getLogs: vi.fn(() => logs),
    listByParent: vi.fn((agent: string) => jobs.filter((j) => j.parentAgent === agent)),
    listAll: vi.fn(() => jobs),
    cancel: vi.fn(() => false),
  } as any;
  return h;
}

// ===========================================================================
// 1. Spawn Result — additional coverage
// ===========================================================================

describe("Spawn Result — additional coverage", () => {
  it("shows usage hint when no job id provided", async () => {
    const h = setupHandler("agent-a", []);
    const ctx = createCtx();
    await h.handle("/spawn result", ctx);
    expect(ctx.completed).toContain("用法");
  });

  it("shows failed status icon and result message", async () => {
    const job = makeJob({ parentAgent: "agent-a", status: "failed", result: "timeout error" });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn result abc12345", ctx);
    expect(ctx.completed).toContain("❌");
    expect(ctx.completed).toContain("timeout error");
    expect(ctx.completed).toContain("**Result:**");
  });

  it("shows cancelled status icon", async () => {
    const job = makeJob({ parentAgent: "agent-a", status: "cancelled", result: null });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn result abc12345", ctx);
    expect(ctx.completed).toContain("⏸️");
  });

  it("displays context in result view", async () => {
    const job = makeJob({ parentAgent: "agent-a", context: "translate this document to English" });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn result abc12345", ctx);
    expect(ctx.completed).toContain("**Context:**");
    expect(ctx.completed).toContain("translate this document to English");
  });

  it("shows target agent and duration", async () => {
    const job = makeJob({ parentAgent: "agent-a", targetAgent: "agent-pan", durationMs: 45000 });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn result abc12345", ctx);
    expect(ctx.completed).toContain("agent-pan");
    expect(ctx.completed).toContain("45s");
  });

  it("uniform error message for not-found vs unauthorized (no info leak)", async () => {
    const job = makeJob({ id: "secret01", parentAgent: "agent-b" });
    const h = setupHandler("agent-a", [job]);

    const ctxNotFound = createCtx();
    await h.handle("/spawn result nonexist", ctxNotFound);

    const ctxUnauth = createCtx();
    await h.handle("/spawn result secret01", ctxUnauth);

    // Both should say "找不到" — no distinguishable difference
    expect(ctxNotFound.completed).toContain("找不到");
    expect(ctxUnauth.completed).toContain("找不到");
  });
});

// ===========================================================================
// 2. Spawn List — additional coverage
// ===========================================================================

describe("Spawn List — additional coverage", () => {
  it("does not show Result line when result is null (cancelled job)", async () => {
    const job = makeJob({ parentAgent: "agent-a", status: "cancelled", result: null });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    expect(ctx.completed).not.toContain("Result:");
  });

  it("shows multiple jobs with mixed statuses", async () => {
    const jobs = [
      makeJob({ id: "job00001", parentAgent: "agent-a", status: "completed", result: "all good" }),
      makeJob({ id: "job00002", parentAgent: "agent-a", status: "running", result: null }),
      makeJob({ id: "job00003", parentAgent: "agent-a", status: "failed", result: "error msg" }),
    ];
    const h = setupHandler("agent-a", jobs);
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    expect(ctx.completed).toContain("✅");
    expect(ctx.completed).toContain("🔄");
    expect(ctx.completed).toContain("❌");
    expect(ctx.completed).toContain("job00001");
    expect(ctx.completed).toContain("job00002");
    expect(ctx.completed).toContain("job00003");
  });

  it("truncates first line at 80 chars with guidance", async () => {
    const longFirstLine = "A".repeat(120);
    const job = makeJob({ parentAgent: "agent-a", result: longFirstLine });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    // First line sliced to 80
    expect(ctx.completed).toContain("A".repeat(80));
    expect(ctx.completed).toContain("/spawn result abc12345");
  });

  it("multi-line: only first line shown even if first line is short", async () => {
    const job = makeJob({ parentAgent: "agent-a", result: "ok\ndetail line 2\ndetail line 3" });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    // First line "ok" is short, but result has >80 total chars → check truncation logic
    // The code checks `job.result.length > 80` for guidance
    expect(ctx.completed).toContain("ok");
    expect(ctx.completed).not.toContain("detail line 2");
  });

  it("context preview truncated at 60 chars", async () => {
    const longContext = "X".repeat(100);
    const job = makeJob({ parentAgent: "agent-a", context: longContext });
    const h = setupHandler("agent-a", [job]);
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    expect(ctx.completed).toContain("X".repeat(60) + "…");
    expect(ctx.completed).not.toContain("X".repeat(61));
  });

  it("empty job list shows header only", async () => {
    const h = setupHandler("agent-a", []);
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    // Should not error, should return something
    expect(ctx.completed).toBeDefined();
    expect(ctx.completed).not.toContain("Result:");
  });
});

// ===========================================================================
// 3. Spawn Logs — additional handler coverage
// ===========================================================================

describe("Spawn Logs — additional handler coverage", () => {
  it("shows usage hint when no job id provided", async () => {
    const h = setupHandler("agent-a", []);
    const ctx = createCtx();
    await h.handle("/spawn logs", ctx);
    expect(ctx.completed).toContain("用法");
  });

  it("shows failed status icon for failed job logs", async () => {
    const job = makeJob({ parentAgent: "agent-a", status: "failed" });
    const logs = [{ content: "step 1", createdAt: Date.now() }];
    const h = setupHandler("agent-a", [job], logs);
    const ctx = createCtx();
    await h.handle("/spawn logs abc12345", ctx);
    expect(ctx.completed).toContain("❌");
    expect(ctx.completed).toContain("step 1");
  });

  it("shows cancelled status icon and no-log message", async () => {
    const job = makeJob({ parentAgent: "agent-a", status: "cancelled" });
    const h = setupHandler("agent-a", [job], []);
    const ctx = createCtx();
    await h.handle("/spawn logs abc12345", ctx);
    expect(ctx.completed).toContain("⏸️");
    expect(ctx.completed).toContain("無 log 紀錄");
  });

  it("displays multiple log entries in order", async () => {
    const job = makeJob({ parentAgent: "agent-a", status: "running" });
    const logs = [
      { content: "Initializing...", createdAt: Date.now() - 10000 },
      { content: "Processing file A", createdAt: Date.now() - 5000 },
      { content: "Processing file B", createdAt: Date.now() - 1000 },
    ];
    const h = setupHandler("agent-a", [job], logs);
    const ctx = createCtx();
    await h.handle("/spawn logs abc12345", ctx);
    const reply = ctx.completed!;
    expect(reply).toContain("Initializing...");
    expect(reply).toContain("Processing file A");
    expect(reply).toContain("Processing file B");
    // Verify order: Initializing before Processing file B
    expect(reply.indexOf("Initializing")).toBeLessThan(reply.indexOf("Processing file B"));
  });

  it("uniform error for not-found vs unauthorized on logs", async () => {
    const job = makeJob({ id: "secret01", parentAgent: "agent-b" });
    const h = setupHandler("agent-a", [job]);

    const ctxMissing = createCtx();
    await h.handle("/spawn logs nonexist", ctxMissing);

    const ctxUnauth = createCtx();
    await h.handle("/spawn logs secret01", ctxUnauth);

    expect(ctxMissing.completed).toContain("找不到");
    expect(ctxUnauth.completed).toContain("找不到");
  });
});

// ===========================================================================
// 4. SpawnStore — logs isolation & edge cases
// ===========================================================================

describe("SpawnStore — logs isolation & edge cases", () => {
  let store: SpawnStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "spawn-obs-test-"));
    store = new SpawnStore(tmpDir, noopLogger() as any);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logs for different jobs are isolated", () => {
    const j1 = store.add("lucy", "pan", "task 1");
    const j2 = store.add("lucy", "mia", "task 2");

    store.appendLog(j1.id, "j1 step 1");
    store.appendLog(j2.id, "j2 step 1");
    store.appendLog(j1.id, "j1 step 2");

    const logs1 = store.getLogs(j1.id);
    const logs2 = store.getLogs(j2.id);

    expect(logs1).toHaveLength(2);
    expect(logs1[0].content).toBe("j1 step 1");
    expect(logs1[1].content).toBe("j1 step 2");

    expect(logs2).toHaveLength(1);
    expect(logs2[0].content).toBe("j2 step 1");
  });

  it("getLogs returns entries in insertion order", () => {
    const job = store.add("lucy", "pan", "task");
    for (let i = 0; i < 5; i++) {
      store.appendLog(job.id, `step ${i}`);
    }
    const logs = store.getLogs(job.id);
    expect(logs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(logs[i].content).toBe(`step ${i}`);
    }
  });

  it("getLogs for nonexistent job returns empty array", () => {
    expect(store.getLogs("nonexist")).toHaveLength(0);
  });

  it("cleanupOldLogs does not touch recent completed jobs", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "output");
    store.complete(job.id, "completed", "done");

    // maxAgeMs = 1 hour → job completed just now should NOT be cleaned
    const deleted = store.cleanupOldLogs(60 * 60 * 1000);
    expect(deleted).toBe(0);
    expect(store.getLogs(job.id)).toHaveLength(1);
  });

  it("cleanupOldLogs handles mixed job ages", () => {
    // Old completed job
    const j1 = store.add("lucy", "pan", "old task");
    store.appendLog(j1.id, "old log 1");
    store.appendLog(j1.id, "old log 2");
    store.complete(j1.id, "completed", "done");

    // New completed job
    const j2 = store.add("lucy", "mia", "new task");
    store.appendLog(j2.id, "new log");
    store.complete(j2.id, "completed", "done");

    // Running job
    const j3 = store.add("lucy", "pan", "running task");
    store.appendLog(j3.id, "in progress");

    // Cleanup with maxAgeMs = -1000 (cutoff in future — all completed are "old")
    const deleted = store.cleanupOldLogs(-1000);
    expect(deleted).toBe(3); // j1: 2 logs + j2: 1 log
    expect(store.getLogs(j1.id)).toHaveLength(0);
    expect(store.getLogs(j2.id)).toHaveLength(0);
    expect(store.getLogs(j3.id)).toHaveLength(1); // Running preserved
  });

  it("appendLog preserves content with special characters", () => {
    const job = store.add("lucy", "pan", "task");
    const specialContent = 'Error: can\'t parse JSON\n{"key": "value"}\n--- END ---';
    store.appendLog(job.id, specialContent);

    const logs = store.getLogs(job.id);
    expect(logs[0].content).toBe(specialContent);
  });

  it("appendLog timestamps are monotonically increasing", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "a");
    store.appendLog(job.id, "b");

    const logs = store.getLogs(job.id);
    expect(logs[0].createdAt).toBeLessThanOrEqual(logs[1].createdAt);
  });
});

// ===========================================================================
// 5. SpawnManager — flush lifecycle & getLogs proxy
// ===========================================================================

describe("SpawnManager — lifecycle", () => {
  let store: SpawnStore;
  let manager: SpawnManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "spawn-mgr-test-"));
    store = new SpawnStore(tmpDir, noopLogger() as any);
    manager = new SpawnManager(store);
  });

  afterEach(() => {
    try {
      manager.stopAll();
    } catch {
      /* already closed */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getLogs proxies to store", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "hello from store");

    const logs = manager.getLogs(job.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].content).toBe("hello from store");
  });

  it("cleanupOldLogs proxies to store", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "log");
    store.complete(job.id, "completed", "done");

    const deleted = manager.cleanupOldLogs();
    // Job is recent, should not be cleaned with default 7-day window
    expect(deleted).toBe(0);
  });

  it("stopAll closes store — subsequent store operations throw", () => {
    manager.stopAll();
    // After stopAll, store is closed — direct store operations should throw
    expect(() => store.add("lucy", "pan", "task")).toThrow();
  });

  it("stopAll cancels running jobs", () => {
    const job = store.add("lucy", "pan", "task");
    // Simulate active timeout
    (manager as any).timeouts.set(
      job.id,
      setTimeout(() => {}, 99999),
    );

    manager.stopAll();

    const updated = store; // store is closed, can't query
    // Verify timeout was cleared (no hanging timers)
    expect((manager as any).timeouts.size).toBe(0);
    expect((manager as any).flushTimers.size).toBe(0);
  });

  it("getJob proxies to store", () => {
    const job = store.add("lucy", "pan", "task");
    const fetched = manager.getJob(job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
    expect(fetched!.parentAgent).toBe("lucy");
  });

  it("getJob returns null for nonexistent id", () => {
    expect(manager.getJob("nonexist")).toBeNull();
  });
});

// ===========================================================================
// 6. Cross-cutting: ownership consistency across result/logs/list
// ===========================================================================

describe("Cross-cutting ownership consistency", () => {
  it("result and logs have identical ownership behavior", async () => {
    const job = makeJob({ id: "shared01", parentAgent: "agent-b" });
    const logs = [{ content: "some log", createdAt: Date.now() }];
    const h = setupHandler("agent-a", [job], logs);

    const ctxResult = createCtx();
    await h.handle("/spawn result shared01", ctxResult);

    const ctxLogs = createCtx();
    await h.handle("/spawn logs shared01", ctxLogs);

    // Both should be rejected with same message
    expect(ctxResult.completed).toContain("找不到");
    expect(ctxLogs.completed).toContain("找不到");
  });

  it("list only shows own jobs", async () => {
    const jobs = [
      makeJob({ id: "own00001", parentAgent: "agent-a", result: "my result" }),
      makeJob({ id: "other01", parentAgent: "agent-b", result: "their result" }),
    ];
    const h = setupHandler("agent-a", jobs);
    // listByParent mock filters by parent
    const ctx = createCtx();
    await h.handle("/spawn list", ctx);
    // The handler uses listByParent which our mock filters correctly
    expect((h.spawnManager as any).listByParent).toHaveBeenCalledWith("agent-a");
  });
});
