import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronStore } from "../../../src/cron/store.js";
import { CronRunner } from "../../../src/cron/runner.js";
import * as routerModule from "../../../src/ipc/router.js";
import type { ActiveAgent } from "../../../src/ipc/types.js";
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

  // -----------------------------------------------------------------------
  // onTick delivery (session-independent)
  // -----------------------------------------------------------------------

  describe("onTick delivery", () => {
    let deliverSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      deliverSpy = vi.spyOn(routerModule, "deliverToAgent").mockResolvedValue({
        text: "done",
        durationMs: 100,
      });
    });

    afterEach(() => {
      deliverSpy.mockRestore();
    });

    it("delivers to correct agent via deliverToAgent (session-independent)", async () => {
      const agents = [makeAgent("lucy"), makeAgent("pan")];
      runner.setAgents(agents);

      const job = store.add("lucy", "* * * * *", "cron test msg");
      runner.schedule(job);

      // Trigger the tick by directly calling the private onTick via schedule
      // We need to wait for cron to fire — instead, we access the internal and simulate
      // Since onTick is private, we'll use a workaround: call the tick manually
      // by accessing the scheduled task callback

      // Wait for cron tick (fires every minute at second 0)
      // Instead of waiting, we test the integration by verifying setAgents works
      // and the runner has access to agents
      expect(runner.size).toBe(1);

      // Access onTick indirectly: the runner constructs content as "[cron:{id}] {message}"
      // and calls deliverToAgent with source "cron:{id}"
      // We'll invoke onTick through prototype access
      const onTick = (runner as any).onTick.bind(runner);
      await onTick(job);

      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(deliverSpy).toHaveBeenCalledWith(
        agents[0], // lucy
        `[cron:${job.id}] cron test msg`,
        expect.objectContaining({ source: `cron:${job.id}` }),
      );

      // Verify run was recorded in DB
      const updated = store.get(job.id)!;
      expect(updated.runCount).toBe(1);
      expect(updated.lastRunAt).toBeGreaterThan(0);
    });

    it("skips tick when agent not found", async () => {
      const agents = [makeAgent("pan")]; // no "lucy"
      runner.setAgents(agents);

      const job = store.add("lucy", "* * * * *", "no agent");

      const onTick = (runner as any).onTick.bind(runner);
      await onTick(job);

      expect(deliverSpy).not.toHaveBeenCalled();
      // runCount should not increment
      expect(store.get(job.id)!.runCount).toBe(0);
    });

    it("does not record run when delivery fails", async () => {
      deliverSpy.mockRejectedValueOnce(new Error("delivery timeout"));

      const agents = [makeAgent("lucy")];
      runner.setAgents(agents);

      const job = store.add("lucy", "* * * * *", "will fail");

      const onTick = (runner as any).onTick.bind(runner);
      await onTick(job);

      expect(deliverSpy).toHaveBeenCalledTimes(1);
      // runCount should not increment on failure
      expect(store.get(job.id)!.runCount).toBe(0);
    });

    it("auto-disables and unschedules after max_runs reached", async () => {
      const agents = [makeAgent("lucy")];
      runner.setAgents(agents);

      const job = store.add("lucy", "* * * * *", "run twice", 2);
      runner.schedule(job);

      const onTick = (runner as any).onTick.bind(runner);

      // First run
      await onTick(job);
      expect(store.get(job.id)!.runCount).toBe(1);
      expect(store.get(job.id)!.enabled).toBe(true);

      // Second run — reaches maxRuns
      await onTick(job);
      expect(store.get(job.id)!.runCount).toBe(2);
      expect(store.get(job.id)!.enabled).toBe(false);
      // Task should be unscheduled
      expect(runner.size).toBe(0);
    });

    it("case-insensitive agent name matching", async () => {
      const agents = [makeAgent("Lucy")]; // uppercase L
      runner.setAgents(agents);

      const job = store.add("lucy", "* * * * *", "case test"); // lowercase

      const onTick = (runner as any).onTick.bind(runner);
      await onTick(job);

      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(deliverSpy).toHaveBeenCalledWith(
        agents[0],
        expect.stringContaining("case test"),
        expect.anything(),
      );
    });

    it("passes bridgeSessionStore to deliverToAgent", async () => {
      const mockSessionStore = { compact: vi.fn() } as any;
      const agents = [makeAgent("lucy")];
      runner.setAgents(agents, mockSessionStore);

      const job = store.add("lucy", "* * * * *", "store test");

      const onTick = (runner as any).onTick.bind(runner);
      await onTick(job);

      expect(deliverSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ bridgeSessionStore: mockSessionStore }),
      );
    });
  });
});
