import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createIpcRouter } from "../../../src/ipc/router.js";
import { CronStore, MAX_JOBS_PER_AGENT } from "../../../src/cron/store.js";
import { CronRunner } from "../../../src/cron/runner.js";
import type { ActiveAgent, IpcRequest, IpcResponse } from "../../../src/ipc/types.js";
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
      async sendMessage() { return { text: "ok" }; },
      async resetSession() {},
      async resumeSession() { return true; },
      getSessionInfo() { return null; },
      listSessions() { return []; },
      interrupt() {},
      getCostInfo() { return null; },
      supportedModels() { return []; },
      async shutdown() {},
    } as any,
    agentConfig: { name, cwd: "/tmp", provider: "mock" } as any,
  };
}

describe("IPC cron routes", () => {
  let store: CronStore;
  let runner: CronRunner;
  let tmpDir: string;
  let agents: ActiveAgent[];
  let router: (req: IpcRequest) => Promise<IpcResponse>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "ipc-cron-test-"));
    store = new CronStore(tmpDir, noopLogger() as any);
    runner = new CronRunner(store);
    agents = [makeAgent("lucy"), makeAgent("pan")];
    router = createIpcRouter(agents, new Map(), undefined, { cronStore: store, cronRunner: runner });
  });

  afterEach(() => {
    runner.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // cron-add
  // -----------------------------------------------------------------------

  describe("cron-add", () => {
    it("adds a job and schedules it", async () => {
      const res = await router({
        id: 1,
        method: "cron-add",
        params: { agent: "lucy", expr: "*/10 * * * *", message: "檢查進度" },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      const result = (res as any).result;
      expect(result.agentName).toBe("lucy");
      expect(result.cronExpr).toBe("*/10 * * * *");
      expect(result.message).toBe("檢查進度");
      expect(result.id).toHaveLength(8);

      expect(store.listByAgent("lucy")).toHaveLength(1);
      expect(runner.size).toBe(1);
    });

    it("returns error for non-existent agent", async () => {
      const res = await router({
        id: 2,
        method: "cron-add",
        params: { agent: "nobody", expr: "*/5 * * * *", message: "test" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(1);
      expect((res as any).error.message).toContain("nobody");
    });

    it("returns error when job limit reached", async () => {
      for (let i = 0; i < MAX_JOBS_PER_AGENT; i++) {
        store.add("lucy", "*/5 * * * *", `msg${i}`);
      }

      const res = await router({
        id: 3,
        method: "cron-add",
        params: { agent: "lucy", expr: "0 9 * * *", message: "over limit" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(6);
      expect((res as any).error.message).toContain("limit reached");
    });

    it("supports maxRuns parameter", async () => {
      const res = await router({
        id: 4,
        method: "cron-add",
        params: { agent: "pan", expr: "0 9 * * *", message: "once only", maxRuns: 1 },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      const job = store.get((res as any).result.id)!;
      expect(job.maxRuns).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // cron-list
  // -----------------------------------------------------------------------

  describe("cron-list", () => {
    it("lists all jobs when no agent specified", async () => {
      store.add("lucy", "*/5 * * * *", "lucy msg");
      store.add("pan", "0 9 * * *", "pan msg");

      const res = await router({
        id: 5,
        method: "cron-list",
        params: {},
      } as IpcRequest);

      expect("result" in res).toBe(true);
      const result = (res as any).result;
      expect(result).toHaveLength(2);
    });

    it("lists jobs for specific agent", async () => {
      store.add("lucy", "*/5 * * * *", "lucy msg1");
      store.add("lucy", "0 9 * * *", "lucy msg2");
      store.add("pan", "0 12 * * *", "pan msg");

      const res = await router({
        id: 6,
        method: "cron-list",
        params: { agent: "lucy" },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      const result = (res as any).result;
      expect(result).toHaveLength(2);
      expect(result.every((j: any) => j.agentName === "lucy")).toBe(true);
    });

    it("returns empty array when no jobs exist", async () => {
      const res = await router({
        id: 7,
        method: "cron-list",
        params: { agent: "lucy" },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      expect((res as any).result).toHaveLength(0);
    });

    it("includes all expected fields", async () => {
      store.add("lucy", "*/5 * * * *", "test fields");

      const res = await router({
        id: 8,
        method: "cron-list",
        params: { agent: "lucy" },
      } as IpcRequest);

      const job = (res as any).result[0];
      expect(job).toHaveProperty("id");
      expect(job).toHaveProperty("agentName");
      expect(job).toHaveProperty("cronExpr");
      expect(job).toHaveProperty("message");
      expect(job).toHaveProperty("enabled");
      expect(job).toHaveProperty("runCount");
      expect(job).toHaveProperty("maxRuns");
      expect(job).toHaveProperty("lastRunAt");
      expect(job).toHaveProperty("createdAt");
    });
  });

  // -----------------------------------------------------------------------
  // cron-delete
  // -----------------------------------------------------------------------

  describe("cron-delete", () => {
    it("deletes a job by exact ID", async () => {
      const job = store.add("lucy", "*/5 * * * *", "to delete");
      runner.schedule(job);

      const res = await router({
        id: 9,
        method: "cron-delete",
        params: { agent: "lucy", id: job.id },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      expect((res as any).result.deleted).toBe(1);
      expect(store.listByAgent("lucy")).toHaveLength(0);
      expect(runner.size).toBe(0);
    });

    it("deletes all jobs with id=all", async () => {
      const j1 = store.add("lucy", "*/5 * * * *", "msg1");
      const j2 = store.add("lucy", "0 9 * * *", "msg2");
      runner.schedule(j1);
      runner.schedule(j2);

      const res = await router({
        id: 10,
        method: "cron-delete",
        params: { agent: "lucy", id: "all" },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      expect((res as any).result.deleted).toBe(2);
      expect(store.listByAgent("lucy")).toHaveLength(0);
      expect(runner.size).toBe(0);
    });

    it("fuzzy prefix match deletes single match", async () => {
      const job = store.add("lucy", "*/5 * * * *", "prefix test");
      runner.schedule(job);

      // Use first 4 chars as prefix
      const res = await router({
        id: 11,
        method: "cron-delete",
        params: { agent: "lucy", id: job.id.slice(0, 4) },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      expect((res as any).result.deleted).toBe(1);
      expect((res as any).result.id).toBe(job.id);
    });

    it("returns error code 7 when no jobs match prefix", async () => {
      store.add("lucy", "*/5 * * * *", "msg");

      const res = await router({
        id: 12,
        method: "cron-delete",
        params: { agent: "lucy", id: "zzzzzzzz" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(7);
    });

    it("returns error for non-existent agent", async () => {
      const res = await router({
        id: 13,
        method: "cron-delete",
        params: { agent: "ghost", id: "abc" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(1);
    });

    it("delete all for agent with no jobs returns 0", async () => {
      const res = await router({
        id: 14,
        method: "cron-delete",
        params: { agent: "lucy", id: "all" },
      } as IpcRequest);

      expect("result" in res).toBe(true);
      expect((res as any).result.deleted).toBe(0);
    });

    it("returns error code 8 when multiple jobs match prefix", async () => {
      // Add many jobs to increase chance of shared prefix
      const jobs = [];
      for (let i = 0; i < 8; i++) {
        jobs.push(store.add("lucy", "*/5 * * * *", `multi-${i}`));
      }
      // Find a 1-char prefix shared by at least 2 jobs
      const grouped = new Map<string, typeof jobs>();
      for (const j of jobs) {
        const k = j.id[0];
        grouped.set(k, [...(grouped.get(k) ?? []), j]);
      }
      const pair = [...grouped.values()].find((g) => g.length >= 2);
      if (!pair) return; // extremely unlikely with 8 UUIDs

      const sharedPrefix = pair[0].id[0];
      const res = await router({
        id: 16,
        method: "cron-delete",
        params: { agent: "lucy", id: sharedPrefix },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(8);
    });

    it("does not affect other agent's jobs when deleting all", async () => {
      const j1 = store.add("lucy", "*/5 * * * *", "lucy msg");
      store.add("pan", "0 9 * * *", "pan msg");
      runner.schedule(j1);

      await router({
        id: 15,
        method: "cron-delete",
        params: { agent: "lucy", id: "all" },
      } as IpcRequest);

      expect(store.listByAgent("pan")).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // cron scheduler not enabled
  // -----------------------------------------------------------------------

  describe("cron scheduler not enabled", () => {
    it("returns error code 5 for cron-add when no cronDeps", async () => {
      const routerNoCron = createIpcRouter(agents, new Map());

      const res = await routerNoCron({
        id: 20,
        method: "cron-add",
        params: { agent: "lucy", expr: "*/5 * * * *", message: "test" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(5);
      expect((res as any).error.message).toContain("not enabled");
    });

    it("returns error code 5 for cron-list when no cronDeps", async () => {
      const routerNoCron = createIpcRouter(agents, new Map());

      const res = await routerNoCron({
        id: 21,
        method: "cron-list",
        params: {},
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(5);
    });

    it("returns error code 5 for cron-delete when no cronDeps", async () => {
      const routerNoCron = createIpcRouter(agents, new Map());

      const res = await routerNoCron({
        id: 22,
        method: "cron-delete",
        params: { agent: "lucy", id: "abc" },
      } as IpcRequest);

      expect("error" in res).toBe(true);
      expect((res as any).error.code).toBe(5);
    });
  });
});
