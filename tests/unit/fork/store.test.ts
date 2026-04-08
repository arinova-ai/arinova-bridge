import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ForkStore, MAX_FORKS_PER_AGENT, MAX_TASK_CHARS } from "../../../src/fork/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("ForkStore", () => {
  let store: ForkStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "fork-store-test-"));
    store = new ForkStore(tmpDir, noopLogger() as any);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds a fork job and retrieves it", () => {
    const job = store.add("lucy", "review the PR");
    expect(job.id).toHaveLength(8);
    expect(job.parentAgent).toBe("lucy");
    expect(job.task).toBe("review the PR");
    expect(job.status).toBe("running");
    expect(job.result).toBeNull();

    const fetched = store.get(job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
  });

  it("lists jobs by parent agent", () => {
    store.add("lucy", "task 1");
    store.add("lucy", "task 2");
    store.add("pan", "task 3");

    expect(store.listByParent("lucy")).toHaveLength(2);
    expect(store.listByParent("pan")).toHaveLength(1);
  });

  it("lists running jobs", () => {
    const j1 = store.add("lucy", "running");
    store.add("lucy", "also running");
    store.complete(j1.id, "completed", "done");

    expect(store.listRunning()).toHaveLength(1);
  });

  it("completes a job", () => {
    const job = store.add("lucy", "task");
    store.complete(job.id, "completed", "result text");

    const updated = store.get(job.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.result).toBe("result text");
    expect(updated.completedAt).toBeGreaterThan(0);
    expect(updated.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("cancels a running job", () => {
    const job = store.add("lucy", "task");
    expect(store.cancel(job.id)).toBe(true);
    expect(store.get(job.id)!.status).toBe("cancelled");
  });

  it("cannot cancel a completed job", () => {
    const job = store.add("lucy", "task");
    store.complete(job.id, "completed", "done");
    expect(store.cancel(job.id)).toBe(false);
  });

  it("enforces per-agent running fork limit", () => {
    for (let i = 0; i < MAX_FORKS_PER_AGENT; i++) {
      store.add("lucy", `task ${i}`);
    }
    expect(() => store.add("lucy", "one too many")).toThrow(/limit reached/);
    expect(() => store.add("pan", "ok")).not.toThrow();
  });

  it("completed jobs don't count toward limit", () => {
    for (let i = 0; i < MAX_FORKS_PER_AGENT; i++) {
      const j = store.add("lucy", `task ${i}`);
      store.complete(j.id, "completed", "done");
    }
    expect(() => store.add("lucy", "new")).not.toThrow();
  });

  it("rejects task exceeding max length", () => {
    expect(() => store.add("lucy", "x".repeat(MAX_TASK_CHARS + 1))).toThrow(/character limit/);
  });

  it("truncates long results", () => {
    const job = store.add("lucy", "task");
    store.complete(job.id, "completed", "y".repeat(60_000));
    const updated = store.get(job.id)!;
    expect(updated.result!.length).toBeLessThan(60_000);
    expect(updated.result!).toContain("truncated");
  });

  it("persists across re-open", () => {
    store.add("lucy", "persistent");
    store.close();

    const store2 = new ForkStore(tmpDir, noopLogger() as any);
    expect(store2.listByParent("lucy")).toHaveLength(1);
    expect(store2.listByParent("lucy")[0].task).toBe("persistent");
    store2.close();
  });
});
