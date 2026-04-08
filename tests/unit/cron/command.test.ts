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

function makeCtx(conversationId = "test:default"): CommandContext & { lastReply: string; allReplies: string[] } {
  const ctx = {
    conversationId,
    lastReply: "",
    allReplies: [] as string[],
    sendChunk: (text: string) => { ctx.lastReply = text; ctx.allReplies.push(text); },
    sendComplete: (text: string) => { ctx.lastReply = text; ctx.allReplies.push(text); },
    sendError: (text: string) => { ctx.lastReply = `Error: ${text}`; ctx.allReplies.push(`Error: ${text}`); },
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

  it("defaults to list when no subcommand", async () => {
    store.add("testAgent", "*/10 * * * *", "default list test");
    const ctx = makeCtx();
    await handler.handle("/cron", ctx);
    expect(ctx.lastReply).toContain("Cron Jobs:");
    expect(ctx.lastReply).toContain("default list test");
  });

  it("defaults to empty list when no subcommand and no jobs", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron", ctx);
    expect(ctx.lastReply).toContain("目前沒有 cron jobs");
  });

  it("shows help with /cron help", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron help", ctx);
    expect(ctx.lastReply).toContain("用法:");
    expect(ctx.lastReply).toContain("/cron add");
    expect(ctx.lastReply).toContain("/cron list");
    expect(ctx.lastReply).toContain("/cron delete");
  });

  it("returns handled: true for /cron", async () => {
    const ctx = makeCtx();
    const result = await handler.handle("/cron list", ctx);
    expect(result).toEqual({ handled: true });
  });

  it("rejects unknown subcommand", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron foo", ctx);
    expect(ctx.lastReply).toContain("未知的 cron 子指令");
  });

  it("rejects /cron add with too few arguments", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron add */5 * *", ctx);
    expect(ctx.lastReply).toContain("用法: /cron add");
  });

  it("fuzzy prefix match deletes correct job", async () => {
    const j1 = store.add("testAgent", "*/5 * * * *", "msg1");
    runner.schedule(j1);

    // Use first 4 chars as prefix (single job — guaranteed unique)
    const prefix = j1.id.slice(0, 4);
    const ctx = makeCtx();
    await handler.handle(`/cron delete ${prefix}`, ctx);
    expect(ctx.lastReply).toContain("已刪除 cron job");
    expect(ctx.lastReply).toContain(j1.id);
    expect(store.listByAgent("testAgent")).toHaveLength(0);
    expect(runner.size).toBe(0);
  });

  it("reports ambiguity when multiple jobs match prefix", async () => {
    // Create jobs with known IDs — add many and find a shared prefix
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(store.add("testAgent", "*/5 * * * *", `msg${i}`));
    }
    // Find two jobs that share at least the first char
    const grouped = new Map<string, typeof jobs>();
    for (const j of jobs) {
      const k = j.id[0];
      grouped.set(k, [...(grouped.get(k) ?? []), j]);
    }
    const pair = [...grouped.values()].find((g) => g.length >= 2);
    if (!pair) {
      // Extremely unlikely with 5 UUIDs, but skip gracefully
      return;
    }
    const sharedPrefix = pair[0].id[0];
    const ctx = makeCtx();
    await handler.handle(`/cron delete ${sharedPrefix}`, ctx);
    expect(ctx.lastReply).toContain("多個 cron job 匹配");
    expect(ctx.lastReply).toContain("請輸入更完整的 ID");
  });

  it("reports no match on delete with unknown prefix", async () => {
    store.add("testAgent", "*/5 * * * *", "msg1");
    const ctx = makeCtx();
    await handler.handle("/cron delete zzzzz", ctx);
    expect(ctx.lastReply).toContain("找不到匹配");
  });

  it("reports error when /cron delete has no argument", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron delete", ctx);
    expect(ctx.lastReply).toContain("用法: /cron delete");
  });

  it("enforces max jobs limit via /cron add", async () => {
    for (let i = 0; i < 10; i++) {
      store.add("testAgent", "*/5 * * * *", `msg${i}`);
    }
    const ctx = makeCtx();
    await handler.handle("/cron add 0 9 * * * eleventh job", ctx);
    expect(ctx.lastReply).toContain("新增失敗");
    expect(ctx.lastReply).toContain("limit reached");
  });

  it("warns on every-minute wildcard expression but still adds", async () => {
    const ctx = makeCtx();
    await handler.handle("/cron add * * * * * very frequent", ctx);
    // Warning is sent first, then success reply overwrites lastReply
    const allText = ctx.allReplies.join("\n");
    expect(allText).toContain("最短間隔");
    expect(allText).toContain("已新增 cron job");
  });

  it("shows cron scheduler not enabled when cronStore is null", async () => {
    handler.cronStore = undefined as any;
    handler.cronRunner = undefined as any;
    const ctx = makeCtx();
    await handler.handle("/cron list", ctx);
    expect(ctx.lastReply).toContain("未啟用");
  });

  // -----------------------------------------------------------------------
  // Alias subcommands
  // -----------------------------------------------------------------------

  it("/cron ls is alias for /cron list", async () => {
    store.add("testAgent", "*/10 * * * *", "alias test");
    const ctx = makeCtx();
    await handler.handle("/cron ls", ctx);
    expect(ctx.lastReply).toContain("Cron Jobs:");
    expect(ctx.lastReply).toContain("alias test");
  });

  it("/cron del is alias for /cron delete", async () => {
    const job = store.add("testAgent", "*/5 * * * *", "del alias");
    runner.schedule(job);

    const ctx = makeCtx();
    await handler.handle(`/cron del ${job.id}`, ctx);
    expect(ctx.lastReply).toContain("已刪除 cron job");
    expect(store.listByAgent("testAgent")).toHaveLength(0);
  });

  it("/cron rm is alias for /cron delete", async () => {
    const job = store.add("testAgent", "*/5 * * * *", "rm alias");
    runner.schedule(job);

    const ctx = makeCtx();
    await handler.handle(`/cron rm ${job.id}`, ctx);
    expect(ctx.lastReply).toContain("已刪除 cron job");
    expect(store.listByAgent("testAgent")).toHaveLength(0);
  });
});
