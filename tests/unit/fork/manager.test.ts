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
});
