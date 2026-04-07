import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CronStore, MAX_JOBS_PER_AGENT } from "../../../src/cron/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function noopLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe("CronStore", () => {
  let store: CronStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cron-test-"));
    store = new CronStore(tmpDir, noopLogger() as any);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds a cron job and retrieves it", () => {
    const job = store.add("agent1", "*/5 * * * *", "check status");
    expect(job.id).toHaveLength(8);
    expect(job.agentName).toBe("agent1");
    expect(job.cronExpr).toBe("*/5 * * * *");
    expect(job.message).toBe("check status");
    expect(job.enabled).toBe(true);
    expect(job.runCount).toBe(0);

    const fetched = store.get(job.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
  });

  it("lists jobs by agent", () => {
    store.add("agent1", "*/5 * * * *", "msg1");
    store.add("agent1", "0 9 * * *", "msg2");
    store.add("agent2", "0 12 * * *", "msg3");

    const agent1Jobs = store.listByAgent("agent1");
    expect(agent1Jobs).toHaveLength(2);

    const agent2Jobs = store.listByAgent("agent2");
    expect(agent2Jobs).toHaveLength(1);
  });

  it("lists all enabled jobs", () => {
    store.add("agent1", "*/5 * * * *", "msg1");
    store.add("agent2", "0 9 * * *", "msg2");

    const enabled = store.listEnabled();
    expect(enabled).toHaveLength(2);
  });

  it("deletes a job by ID", () => {
    const job = store.add("agent1", "*/5 * * * *", "msg1");
    expect(store.delete(job.id)).toBe(true);
    expect(store.get(job.id)).toBeNull();
  });

  it("deletes all jobs by agent", () => {
    store.add("agent1", "*/5 * * * *", "msg1");
    store.add("agent1", "0 9 * * *", "msg2");
    store.add("agent2", "0 12 * * *", "msg3");

    const count = store.deleteAllByAgent("agent1");
    expect(count).toBe(2);
    expect(store.listByAgent("agent1")).toHaveLength(0);
    expect(store.listByAgent("agent2")).toHaveLength(1);
  });

  it("records a run and increments count", () => {
    const job = store.add("agent1", "*/5 * * * *", "msg1");
    store.recordRun(job.id);

    const updated = store.get(job.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunAt).toBeGreaterThan(0);
  });

  it("auto-disables after max_runs", () => {
    const job = store.add("agent1", "*/5 * * * *", "msg1", 2);
    store.recordRun(job.id);
    expect(store.get(job.id)!.enabled).toBe(true);

    store.recordRun(job.id);
    expect(store.get(job.id)!.enabled).toBe(false);
  });

  it("enforces per-agent job limit", () => {
    for (let i = 0; i < MAX_JOBS_PER_AGENT; i++) {
      store.add("agent1", "*/5 * * * *", `msg${i}`);
    }

    expect(() => store.add("agent1", "*/5 * * * *", "one too many"))
      .toThrow(/limit reached/);

    // Different agent should still work
    expect(() => store.add("agent2", "*/5 * * * *", "msg")).not.toThrow();
  });

  it("returns false when deleting non-existent job", () => {
    expect(store.delete("nonexistent")).toBe(false);
  });

  it("persists across re-open", () => {
    store.add("agent1", "*/5 * * * *", "persistent msg");
    store.close();

    const store2 = new CronStore(tmpDir, noopLogger() as any);
    const jobs = store2.listByAgent("agent1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].message).toBe("persistent msg");
    store2.close();
  });
});
