import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CommandHandler } from "../../../src/commands/handler.js";
import { CronStore } from "../../../src/cron/store.js";
import { CronRunner } from "../../../src/cron/runner.js";
import type { CommandContext, CommandResult } from "../../../src/commands/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function makeCtx(conversationId = "test:default"): CommandContext & { lastReply: string } {
  const ctx = {
    conversationId,
    lastReply: "",
    sendChunk: (text: string) => { ctx.lastReply = text; },
    sendComplete: (text: string) => { ctx.lastReply = text; },
    sendError: (text: string) => { ctx.lastReply = `Error: ${text}`; },
    uploadFile: async () => ({ url: "", fileName: "", fileType: "", fileSize: 0 }),
  };
  return ctx;
}

function makeMockProvider() {
  return {
    id: "mock",
    type: "mock",
    displayName: "Mock",
    async sendMessage() { return { text: "ok", durationMs: 0 }; },
    async resetSession() {},
    async resumeSession() { return true; },
    getSessionInfo() { return null; },
    listSessions() { return []; },
    interrupt() {},
    getCostInfo() { return null; },
    getUsageInfo() { return null; },
    supportedModels() { return []; },
    warmup() {},
    async shutdown() {},
  } as any;
}

describe("/cron command", () => {
  let handler: CommandHandler;
  let store: CronStore;
  let runner: CronRunner;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cron-cmd-test-"));
    store = new CronStore(tmpDir, noopLogger() as any);
    runner = new CronRunner(store);

    const providers = new Map([["mock", makeMockProvider()]]);
    handler = new CommandHandler(providers, {
      defaultProvider: "mock",
      providers: [{ id: "mock", type: "mock", enabled: true }],
      defaults: { cwd: "/tmp" },
      arinova: { serverUrl: "" },
      agents: [],
    } as any);
    handler.cronStore = store;
    handler.cronRunner = runner;
    handler.agentName = "testAgent";
  });

  afterEach(() => {
    runner.stopAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds a cron job", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron add */5 * * * * check email", ctx);
    expect(ctx.lastReply).toContain("已新增 cron job");
    expect(ctx.lastReply).toContain("*/5 * * * *");

    const jobs = store.listByAgent("testAgent");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].message).toBe("check email");
  });

  it("lists cron jobs", async () => {
    store.add("testAgent", "*/5 * * * *", "msg1");
    store.add("testAgent", "0 9 * * *", "msg2");

    const ctx = makeCtx();
    await handler.handle("/cron list", ctx);
    expect(ctx.lastReply).toContain("Cron Jobs:");
    expect(ctx.lastReply).toContain("msg1");
    expect(ctx.lastReply).toContain("msg2");
  });

  it("shows empty state when no jobs", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron list", ctx);
    expect(ctx.lastReply).toContain("目前沒有 cron jobs");
  });

  it("deletes a cron job by ID", async () => {
    const job = store.add("testAgent", "*/5 * * * *", "msg1");
    runner.schedule(job);

    const ctx = makeCtx();
    await handler.handle(`/cron delete ${job.id}`, ctx);
    expect(ctx.lastReply).toContain("已刪除 cron job");
    expect(store.listByAgent("testAgent")).toHaveLength(0);
    expect(runner.size).toBe(0);
  });

  it("deletes all cron jobs", async () => {
    const j1 = store.add("testAgent", "*/5 * * * *", "msg1");
    const j2 = store.add("testAgent", "0 9 * * *", "msg2");
    runner.schedule(j1);
    runner.schedule(j2);

    const ctx = makeCtx();
    await handler.handle("/cron delete all", ctx);
    expect(ctx.lastReply).toContain("已刪除 2 個 cron job(s)");
    expect(store.listByAgent("testAgent")).toHaveLength(0);
    expect(runner.size).toBe(0);
  });

  it("rejects invalid cron expression", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron add 99 99 99 99 99 test message", ctx);
    expect(ctx.lastReply).toContain("無效的 cron expression");
  });

  it("shows help with no subcommand", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron", ctx);
    expect(ctx.lastReply).toContain("用法:");
  });

  it("returns handled: true for /cron", async () => {
    const ctx = makeCtx();
    const result = await handler.handle("/cron list", ctx);
    expect(result).toEqual({ handled: true });
  });
});
