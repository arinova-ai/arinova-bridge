import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpawnStore } from "../../../src/spawn/store.js";
import { SpawnManager } from "../../../src/spawn/manager.js";
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

describe("SpawnManager", () => {
  let store: SpawnStore;
  let manager: SpawnManager;
  let tmpDir: string;
  let deliverSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "spawn-mgr-test-"));
    store = new SpawnStore(tmpDir, noopLogger() as any);
    manager = new SpawnManager(store);

    deliverSpy = vi.spyOn(routerModule, "deliverToAgent").mockResolvedValue({
      text: "task completed successfully",
      durationMs: 5000,
    });
  });

  afterEach(() => {
    manager.stopAll();
    deliverSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("spawns a job and delivers to target agent", async () => {
    const agents = [makeAgent("lucy"), makeAgent("pan")];
    manager.setAgents(agents);

    const job = manager.spawn({
      parentAgent: "lucy",
      targetAgent: "pan",
      context: "build the feature",
    });

    expect(job.id).toHaveLength(8);
    expect(job.status).toBe("running");

    // Wait for background execution
    await vi.waitFor(() => {
      expect(deliverSpy).toHaveBeenCalledTimes(2); // deliver to target + report to parent
    });

    // First call: deliver context to target
    expect(deliverSpy).toHaveBeenNthCalledWith(
      1,
      agents[1], // pan
      "build the feature",
      expect.objectContaining({ source: `spawn:${job.id}` }),
    );

    // Second call: report result back to parent
    expect(deliverSpy).toHaveBeenNthCalledWith(
      2,
      agents[0], // lucy
      expect.stringContaining(`[spawn:${job.id} from:pan]`),
      expect.anything(),
    );

    // Verify DB state
    const updated = store.get(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.result).toBe("task completed successfully");
  });

  it("marks job as failed when target agent not found", async () => {
    const agents = [makeAgent("lucy")]; // no "pan"
    manager.setAgents(agents);

    const job = manager.spawn({
      parentAgent: "lucy",
      targetAgent: "pan",
      context: "task",
    });

    await vi.waitFor(() => {
      const updated = store.get(job.id)!;
      expect(updated.status).toBe("failed");
    });

    const updated = store.get(job.id)!;
    expect(updated.result).toContain("not found");
  });

  it("marks job as failed when delivery throws", async () => {
    deliverSpy.mockRejectedValueOnce(new Error("connection refused"));

    const agents = [makeAgent("lucy"), makeAgent("pan")];
    manager.setAgents(agents);

    const job = manager.spawn({
      parentAgent: "lucy",
      targetAgent: "pan",
      context: "will fail",
    });

    await vi.waitFor(() => {
      const updated = store.get(job.id)!;
      expect(updated.status).toBe("failed");
    });

    const updated = store.get(job.id)!;
    expect(updated.result).toContain("connection refused");
  });

  it("cancels a running job", () => {
    const agents = [makeAgent("lucy"), makeAgent("pan")];
    manager.setAgents(agents);

    // Don't resolve deliver so job stays running
    deliverSpy.mockImplementation(() => new Promise(() => {}));

    const job = manager.spawn({
      parentAgent: "lucy",
      targetAgent: "pan",
      context: "long task",
    });

    const cancelled = manager.cancel(job.id);
    expect(cancelled).toBe(true);

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("cancelled");
  });

  it("recovers stale jobs on startup", () => {
    // Manually insert an old running job
    const job = store.add("lucy", "pan", "stale task");
    // Hack the created_at to make it old
    (store as any).db.prepare("UPDATE spawn_jobs SET created_at = ? WHERE id = ?")
      .run(Date.now() - 40 * 60 * 1000, job.id); // 40 minutes ago

    const recovered = manager.recoverStale();
    expect(recovered).toBe(1);

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.result).toContain("stale");
  });

  it("stopAll cancels active jobs", () => {
    const agents = [makeAgent("lucy"), makeAgent("pan")];
    manager.setAgents(agents);

    deliverSpy.mockImplementation(() => new Promise(() => {}));

    manager.spawn({ parentAgent: "lucy", targetAgent: "pan", context: "task 1" });
    manager.spawn({ parentAgent: "lucy", targetAgent: "pan", context: "task 2" });

    expect(manager.activeCount).toBe(2);
    manager.stopAll();
    expect(manager.activeCount).toBe(0);
  });
});
