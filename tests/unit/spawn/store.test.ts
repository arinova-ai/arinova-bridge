import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SpawnStore, MAX_SPAWNS_PER_AGENT, MAX_CONTEXT_CHARS } from "../../../src/spawn/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("SpawnStore", () => {
  let store: SpawnStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "spawn-test-"));
    store = new SpawnStore(tmpDir, noopLogger() as any);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds a spawn job and retrieves it", () => {
    const job = store.add("lucy", "pan", "do the task");
    expect(job.id).toHaveLength(8);
    expect(job.parentAgent).toBe("lucy");
    expect(job.targetAgent).toBe("pan");
    expect(job.context).toBe("do the task");
    expect(job.status).toBe("running");
    expect(job.result).toBeNull();

    const fetched = store.get(job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
  });

  it("lists jobs by parent agent", () => {
    store.add("lucy", "pan", "task 1");
    store.add("lucy", "mia", "task 2");
    store.add("pan", "lucy", "task 3");

    const lucyJobs = store.listByParent("lucy");
    expect(lucyJobs).toHaveLength(2);

    const panJobs = store.listByParent("pan");
    expect(panJobs).toHaveLength(1);
  });

  it("lists running jobs", () => {
    const j1 = store.add("lucy", "pan", "running task");
    store.add("lucy", "mia", "another running");
    store.complete(j1.id, "completed", "done");

    const running = store.listRunning();
    expect(running).toHaveLength(1);
  });

  it("completes a job", () => {
    const job = store.add("lucy", "pan", "task");
    store.complete(job.id, "completed", "result text", 0.05);

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.result).toBe("result text");
    expect(updated.completedAt).toBeGreaterThan(0);
    expect(updated.durationMs).toBeGreaterThanOrEqual(0);
    expect(updated.costUsd).toBe(0.05);
  });

  it("marks a job as failed", () => {
    const job = store.add("lucy", "pan", "task");
    store.complete(job.id, "failed", "error message");

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.result).toBe("error message");
  });

  it("cancels a running job", () => {
    const job = store.add("lucy", "pan", "task");
    const ok = store.cancel(job.id);
    expect(ok).toBe(true);

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("cancelled");
  });

  it("cannot cancel a completed job", () => {
    const job = store.add("lucy", "pan", "task");
    store.complete(job.id, "completed", "done");
    const ok = store.cancel(job.id);
    expect(ok).toBe(false);
  });

  it("enforces per-agent running spawn limit", () => {
    for (let i = 0; i < MAX_SPAWNS_PER_AGENT; i++) {
      store.add("lucy", "pan", `task ${i}`);
    }

    expect(() => store.add("lucy", "pan", "one too many"))
      .toThrow(/limit reached/);

    // Different agent should work
    expect(() => store.add("pan", "lucy", "ok")).not.toThrow();
  });

  it("completed jobs don't count toward limit", () => {
    for (let i = 0; i < MAX_SPAWNS_PER_AGENT; i++) {
      const j = store.add("lucy", "pan", `task ${i}`);
      store.complete(j.id, "completed", "done");
    }

    // All completed, so adding another should work
    expect(() => store.add("lucy", "pan", "new task")).not.toThrow();
  });

  it("rejects context exceeding max length", () => {
    const longContext = "x".repeat(MAX_CONTEXT_CHARS + 1);
    expect(() => store.add("lucy", "pan", longContext))
      .toThrow(/character limit/);
  });

  it("truncates result exceeding max length", () => {
    const job = store.add("lucy", "pan", "task");
    const longResult = "y".repeat(60_000);
    store.complete(job.id, "completed", longResult);

    const updated = store.get(job.id)!;
    expect(updated.result!.length).toBeLessThan(60_000);
    expect(updated.result!).toContain("truncated");
  });

  it("counts running jobs by parent", () => {
    store.add("lucy", "pan", "task 1");
    store.add("lucy", "mia", "task 2");
    const j3 = store.add("lucy", "pan", "task 3");
    store.complete(j3.id, "completed", "done");

    expect(store.countRunningByParent("lucy")).toBe(2);
  });

  it("persists across re-open", () => {
    store.add("lucy", "pan", "persistent task");
    store.close();

    const store2 = new SpawnStore(tmpDir, noopLogger() as any);
    const jobs = store2.listByParent("lucy");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].context).toBe("persistent task");
    store2.close();
  });

  // ---------------------------------------------------------------------------
  // Spawn Logs
  // ---------------------------------------------------------------------------

  it("appends and retrieves logs for a job", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "step 1 output");
    store.appendLog(job.id, "step 2 output");

    const logs = store.getLogs(job.id);
    expect(logs).toHaveLength(2);
    expect(logs[0].content).toBe("step 1 output");
    expect(logs[1].content).toBe("step 2 output");
    expect(logs[0].createdAt).toBeLessThanOrEqual(logs[1].createdAt);
  });

  it("returns empty logs for job with no log entries", () => {
    const job = store.add("lucy", "pan", "task");
    expect(store.getLogs(job.id)).toHaveLength(0);
  });

  it("cleanupOldLogs removes logs for old completed jobs", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "some output");
    // Complete the job
    store.complete(job.id, "completed", "done");

    // Clean with maxAgeMs = -1000 so cutoff is in the future (anything completed is "old")
    const deleted = store.cleanupOldLogs(-1000);
    expect(deleted).toBe(1);
    expect(store.getLogs(job.id)).toHaveLength(0);
  });

  it("cleanupOldLogs preserves logs for running jobs", () => {
    const job = store.add("lucy", "pan", "task");
    store.appendLog(job.id, "in progress");

    // Running jobs have no completed_at, so cleanup should not touch them
    const deleted = store.cleanupOldLogs(0);
    expect(deleted).toBe(0);
    expect(store.getLogs(job.id)).toHaveLength(1);
  });
});
