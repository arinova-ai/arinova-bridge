import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ForkStore } from "../../../src/fork/store.js";
import { ForkManager } from "../../../src/fork/manager.js";
import * as routerModule from "../../../src/ipc/router.js";
import type { ActiveAgent } from "../../../src/ipc/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeAgent(name: string): ActiveAgent {
  return {
    name,
    agent: {} as any,
    hudWs: {} as any,
    commandHandler: {} as any,
    provider: {
      id: `${name}-provider`,
      type: "mock",
      displayName: name,
    } as any,
    agentConfig: { name, cwd: "/tmp", provider: "mock" } as any,
  };
}

describe("ForkManager", () => {
  let store: ForkStore;
  let manager: ForkManager;
  let tmpDir: string;
  let deliverSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "fork-mgr-test-"));
    store = new ForkStore(tmpDir, noopLogger() as any);
    manager = new ForkManager(store);

    deliverSpy = vi.spyOn(routerModule, "deliverToAgent").mockResolvedValue({
      text: "fork task completed",
      durationMs: 3000,
    });
  });

  afterEach(() => {
    manager.stopAll();
    deliverSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forks a job and reports result back", async () => {
    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const job = manager.fork({
      parentAgent: "lucy",
      task: "review the code",
    });

    expect(job.id).toHaveLength(8);
    expect(job.status).toBe("running");

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2); // execute + report
    });

    // First call: deliver task to same agent (fork sub-session)
    expect(deliverSpy).toHaveBeenNthCalledWith(
      1,
      agents[0],
      expect.stringContaining("review the code"),
      expect.objectContaining({ source: `fork:${job.id}` }),
    );

    // Second call: report result back to parent
    expect(deliverSpy).toHaveBeenNthCalledWith(
      2,
      agents[0],
      expect.stringContaining(`[fork:${job.id}]`),
      expect.anything(),
    );

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.result).toBe("fork task completed");
  });

  it("marks job as failed when agent not found", async () => {
    manager.setAgents([]); // no agents

    const job = manager.fork({
      parentAgent: "lucy",
      task: "task",
    });

    await vi.waitFor(() => {
      expect(store.get(job.id)!.status).toBe("failed");
    });
    expect(store.get(job.id)!.result).toContain("not found");
  });

  it("marks job as failed when delivery throws", async () => {
    deliverSpy.mockRejectedValueOnce(new Error("process crashed"));

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const job = manager.fork({ parentAgent: "lucy", task: "will fail" });

    await vi.waitFor(() => {
      expect(store.get(job.id)!.status).toBe("failed");
    });
    expect(store.get(job.id)!.result).toContain("process crashed");
  });

  it("cancels a running fork", () => {
    deliverSpy.mockImplementation(() => new Promise(() => {})); // never resolves

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const job = manager.fork({ parentAgent: "lucy", task: "long task" });

    expect(manager.cancel(job.id)).toBe(true);
    expect(store.get(job.id)!.status).toBe("cancelled");
  });

  it("recovers stale jobs on startup", () => {
    const job = store.add("lucy", "stale task");

    const recovered = manager.recoverStale();
    expect(recovered).toBe(1);
    expect(store.get(job.id)!.status).toBe("failed");
    expect(store.get(job.id)!.result).toContain("Stale");
  });

  it("stopAll cancels active forks", () => {
    deliverSpy.mockImplementation(() => new Promise(() => {}));

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    manager.fork({ parentAgent: "lucy", task: "task 1" });
    manager.fork({ parentAgent: "lucy", task: "task 2" });

    expect(manager.activeCount).toBe(2);
    manager.stopAll();
    expect(manager.activeCount).toBe(0);
  });

  it("public proxy methods work", () => {
    store.add("lucy", "task 1");
    store.add("lucy", "task 2");
    store.add("pan", "task 3");

    expect(manager.listByParent("lucy")).toHaveLength(2);
    expect(manager.listAll()).toHaveLength(3);
    expect(manager.getJob(manager.listAll()[0].id)).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Edge cases: job already cancelled/timed-out before delivery returns
  // ---------------------------------------------------------------------------

  it("skips result when job already cancelled before delivery resolves", async () => {
    let resolveDeliver!: (v: { text: string; durationMs: number }) => void;
    deliverSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeliver = resolve;
        }),
    );

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const job = manager.fork({ parentAgent: "lucy", task: "will be cancelled mid-flight" });

    // Cancel while delivery is still in-flight
    manager.cancel(job.id);
    expect(store.get(job.id)!.status).toBe("cancelled");

    // Resolve the delivery — manager should detect status != running
    resolveDeliver({ text: "too late", durationMs: 100 });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(1);
    });

    // Status should remain cancelled
    expect(store.get(job.id)!.status).toBe("cancelled");
  });

  it("skips result when job already failed (stale) before delivery resolves", async () => {
    let resolveDeliver!: (v: { text: string; durationMs: number }) => void;
    deliverSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDeliver = resolve;
        }),
    );

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const job = manager.fork({ parentAgent: "lucy", task: "will be marked stale" });

    // Simulate external failure (e.g. recoverStale)
    store.complete(job.id, "failed", "Stale — bridge restarted");

    resolveDeliver({ text: "result after stale", durationMs: 50 });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(1);
    });

    expect(store.get(job.id)!.status).toBe("failed");
    expect(store.get(job.id)!.result).toContain("Stale");
  });

  it("skips update when delivery rejects but job already cancelled", async () => {
    let rejectDeliver!: (err: Error) => void;
    deliverSpy.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDeliver = reject;
        }),
    );

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const job = manager.fork({ parentAgent: "lucy", task: "error after cancel" });

    manager.cancel(job.id);
    expect(store.get(job.id)!.status).toBe("cancelled");

    rejectDeliver(new Error("too late error"));

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(1);
    });

    // Should remain cancelled, not overwritten to failed
    expect(store.get(job.id)!.status).toBe("cancelled");
  });

  // ---------------------------------------------------------------------------
  // reportToParent edge cases
  // ---------------------------------------------------------------------------

  it("handles parent agent disappearing between execute and report", async () => {
    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    let callCount = 0;
    deliverSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Remove agent so reportToParent can't find it
        manager.setAgents([]);
        return { text: "done", durationMs: 100 };
      }
      return { text: "", durationMs: 0 };
    });

    const job = manager.fork({ parentAgent: "lucy", task: "parent will vanish" });

    await vi.waitFor(() => {
      expect(store.get(job.id)!.status).toBe("completed");
    });

    // deliverToAgent should only be called once (execute), not for report
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it("handles deliverToAgent rejection during reportToParent", async () => {
    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    let callCount = 0;
    deliverSpy.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { text: "fork result", durationMs: 100 };
      }
      throw new Error("report delivery failed");
    });

    const job = manager.fork({ parentAgent: "lucy", task: "report will fail" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    // Job itself should be completed even though report failed
    const updated = store.get(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.result).toBe("fork result");
  });

  // ---------------------------------------------------------------------------
  // bridgeSessionStore context prefix
  // ---------------------------------------------------------------------------

  it("builds context prefix from bridgeSessionStore when available", async () => {
    const agents = [makeAgent("lucy")];
    const mockBridgeSessionStore = {
      buildContext: vi.fn().mockReturnValue("some context from main session"),
    } as any;
    manager.setAgents(agents, mockBridgeSessionStore);

    manager.fork({ parentAgent: "lucy", task: "task with context" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    const firstCallArgs = deliverSpy.mock.calls[0];
    expect(firstCallArgs[1]).toContain("[Fork context from main session]");
    expect(firstCallArgs[1]).toContain("some context from main session");
    expect(firstCallArgs[1]).toContain("task with context");
    expect(mockBridgeSessionStore.buildContext).toHaveBeenCalledWith("lucy:default");
  });

  it("skips context prefix when bridgeSessionStore returns empty", async () => {
    const agents = [makeAgent("lucy")];
    const mockBridgeSessionStore = {
      buildContext: vi.fn().mockReturnValue(""),
    } as any;
    manager.setAgents(agents, mockBridgeSessionStore);

    manager.fork({ parentAgent: "lucy", task: "task no context" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    const firstCallArgs = deliverSpy.mock.calls[0];
    expect(firstCallArgs[1]).not.toContain("[Fork context from main session]");
    expect(firstCallArgs[1]).toContain("task no context");
  });

  // ---------------------------------------------------------------------------
  // Misc edge cases
  // ---------------------------------------------------------------------------

  it("uses custom cwd when provided", async () => {
    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    manager.fork({ parentAgent: "lucy", task: "with cwd", cwd: "/custom/path" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    const opts = deliverSpy.mock.calls[0][2] as any;
    expect(opts.cwd).toBe("/custom/path");
  });

  it("passes model to deliverToAgent when specified", async () => {
    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    manager.fork({ parentAgent: "lucy", task: "with model", model: "gpt-4" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    const opts = deliverSpy.mock.calls[0][2] as any;
    expect(opts.model).toBe("gpt-4");
  });

  it("cancel returns false for non-existent job", () => {
    expect(manager.cancel("nonexistent")).toBe(false);
  });

  it("recoverStale returns 0 when no running jobs exist", () => {
    expect(manager.recoverStale()).toBe(0);
  });

  it("recoverStale marks multiple stale jobs as failed", () => {
    store.add("lucy", "stale 1");
    store.add("lucy", "stale 2");
    store.add("pan", "stale 3");

    const recovered = manager.recoverStale();
    expect(recovered).toBe(3);

    const all = store.listAll();
    for (const job of all) {
      expect(job.status).toBe("failed");
      expect(job.result).toContain("Stale");
    }
  });

  it("truncates long result in reportToParent preview", async () => {
    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    const longText = "x".repeat(3000);
    deliverSpy.mockResolvedValueOnce({ text: longText, durationMs: 100 });

    manager.fork({ parentAgent: "lucy", task: "long result" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    // Second call is the report — check the content has truncation marker
    const reportContent = deliverSpy.mock.calls[1][1] as string;
    expect(reportContent).toContain("...(truncated)");
    expect(reportContent.length).toBeLessThan(longText.length);
  });

  it("reports failure to parent with 失敗 label when fork fails", async () => {
    deliverSpy.mockRejectedValueOnce(new Error("kaboom"));

    const agents = [makeAgent("lucy")];
    manager.setAgents(agents);

    manager.fork({ parentAgent: "lucy", task: "will fail" });

    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    });

    const reportContent = deliverSpy.mock.calls[1][1] as string;
    expect(reportContent).toContain("失敗");
    expect(reportContent).toContain("kaboom");
  });
});
