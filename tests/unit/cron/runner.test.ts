import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronStore } from "../../../src/cron/store.js";
import { CronRunner } from "../../../src/cron/runner.js";
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

describe("CronRunner", () => {
  let store: CronStore;
  let runner: CronRunner;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cron-runner-test-"));
    store = new CronStore(tmpDir, noopLogger() as any);
    runner = new CronRunner(store);
  });

  afterEach(() => {
    runner.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("schedules a valid job", () => {
    const job = store.add("agent1", "*/5 * * * *", "test message");
    const ok = runner.schedule(job);
    expect(ok).toBe(true);
    expect(runner.size).toBe(1);
  });

  it("rejects invalid cron expression", () => {
    const job = store.add("agent1", "invalid expr here", "test");
    // Manually create a job object with bad expression to test schedule
    const ok = runner.schedule({ ...job, cronExpr: "not valid" });
    expect(ok).toBe(false);
    expect(runner.size).toBe(0);
  });

  it("unschedules a job", () => {
    const job = store.add("agent1", "*/5 * * * *", "test");
    runner.schedule(job);
    expect(runner.size).toBe(1);

    runner.unschedule(job.id);
    expect(runner.size).toBe(0);
  });

  it("stopAll clears all tasks", () => {
    store.add("agent1", "*/5 * * * *", "msg1");
    store.add("agent1", "0 9 * * *", "msg2");

    const jobs = store.listByAgent("agent1");
    for (const job of jobs) runner.schedule(job);
    expect(runner.size).toBe(2);

    runner.stopAll();
    expect(runner.size).toBe(0);
  });

  it("restoreAll loads enabled jobs from store", () => {
    store.add("agent1", "*/5 * * * *", "msg1");
    store.add("agent2", "0 9 * * *", "msg2");

    const count = runner.restoreAll();
    expect(count).toBe(2);
    expect(runner.size).toBe(2);
  });

  it("re-scheduling replaces existing task", () => {
    const job = store.add("agent1", "*/5 * * * *", "msg1");
    runner.schedule(job);
    runner.schedule(job); // re-schedule
    expect(runner.size).toBe(1); // should not duplicate
  });
});
