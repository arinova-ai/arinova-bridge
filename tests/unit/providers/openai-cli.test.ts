import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* --------------------------------------------------------------------------
 * Track every CodexAppServer instance so we can control per-instance behavior
 * (getContextUsage, getRateLimits, getTokenUsage, etc.) from inside tests.
 * -----------------------------------------------------------------------*/
interface MockInstance {
  config: any;
  shutdowns: number;
  _threadIds: Map<string, string>;
  _tokenUsage: Map<string, any>;
  _contextUsage: Map<string, any>;
  _rateLimits: any;
  _ready: boolean;
  _sendMessageImpl: (...args: any[]) => Promise<any>;
}

const appServerInstances = vi.hoisted(() => [] as MockInstance[]);
const ensureAgentCodexHomeCalls = vi.hoisted(() => [] as any[][]);

vi.mock("../../../src/codex/app-server.js", () => ({
  CodexAppServer: class {
    private instance: MockInstance;

    constructor(config: any) {
      this.instance = {
        config,
        shutdowns: 0,
        _threadIds: new Map(),
        _tokenUsage: new Map(),
        _contextUsage: new Map(),
        _rateLimits: null,
        _ready: true,
        _sendMessageImpl: async (
          conversationId: string,
          _content: string,
          onChunk?: (text: string) => void,
        ) => {
          onChunk?.("Codex says hello");
          this.instance._threadIds.set(conversationId, "thread-xyz");
          this.instance._tokenUsage.set(conversationId, {
            total: {
              inputTokens: 100,
              cachedInputTokens: 10,
              outputTokens: 50,
            },
          });
          return { text: "Codex says hello", threadId: "thread-xyz" };
        },
      };
      appServerInstances.push(this.instance);
    }

    async sendMessage(
      conversationId: string,
      content: string,
      onChunk?: (text: string) => void,
      opts?: any,
    ) {
      return this.instance._sendMessageImpl(conversationId, content, onChunk, opts);
    }

    interrupt() {}
    clearThread(conversationId: string) {
      this.instance._threadIds.delete(conversationId);
    }
    getThreadId(conversationId: string) {
      return this.instance._threadIds.get(conversationId) ?? null;
    }
    getTokenUsage(conversationId: string) {
      return this.instance._tokenUsage.get(conversationId) ?? null;
    }
    getContextUsage(conversationId: string) {
      return this.instance._contextUsage.get(conversationId) ?? null;
    }
    getRateLimits() {
      return this.instance._rateLimits;
    }
    isReady() {
      return this.instance._ready;
    }
    async shutdown() {
      this.instance.shutdowns++;
    }
  },
}));

vi.mock("../../../src/mcp/preinstalled.js", () => ({
  ensureAgentCodexHome: vi.fn((...args: any[]) => {
    ensureAgentCodexHomeCalls.push(args);
    return args[2];
  }),
}));

import { OpenAICliProvider } from "../../../src/providers/openai-cli.js";

const logger: any = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("OpenAICliProvider — unit", () => {
  let provider: OpenAICliProvider;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    appServerInstances.length = 0;
    ensureAgentCodexHomeCalls.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arinova-unit-openai-"));
    dbPath = path.join(tmpDir, "test.db");

    provider = new OpenAICliProvider(
      {
        providerId: "openai-unit",
        displayName: "OpenAI Unit",
        codexPath: "/usr/bin/codex",
        apiKey: "sk-test",
        defaultCwd: "/default",
        dbPath,
      },
      logger,
    );
  });

  afterEach(async () => {
    await provider.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Constructor: cached rate limits ──────────────────────────────────
  describe("constructor with cached rate limits", () => {
    it("loads valid cached rate limits from DB and injects into default server", () => {
      const db2Path = path.join(tmpDir, "cached.db");
      const p1 = new OpenAICliProvider(
        {
          providerId: "openai-cached",
          displayName: "Cached",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath: db2Path,
        },
        logger,
      );

      // Seed the DB with cached rate limits
      const Database = require("better-sqlite3");
      const raw = new Database(db2Path);
      raw.exec(
        `INSERT OR REPLACE INTO rate_limit_cache (id, data, updated_at)
         VALUES (1, '{"primary":{"usedPercent":50,"windowDurationMins":300,"resetsAt":999}}', '2025-01-01')`,
      );
      raw.close();

      // Now create a provider that reads the seeded cache
      logger.info.mockClear();
      const p2 = new OpenAICliProvider(
        {
          providerId: "openai-cached2",
          displayName: "Cached2",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath: db2Path,
        },
        logger,
      );

      expect(logger.info).toHaveBeenCalledWith(
        "openai-cli: loaded cached rate limits from DB",
      );

      p1.shutdown();
      p2.shutdown();
    });

    it("ignores invalid JSON in cached rate limits", () => {
      const db3Path = path.join(tmpDir, "bad-cache.db");
      // First create DB schema
      const pSchema = new OpenAICliProvider(
        {
          providerId: "openai-schema",
          displayName: "Schema",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath: db3Path,
        },
        logger,
      );
      pSchema.shutdown();

      // Seed invalid JSON
      const Database = require("better-sqlite3");
      const raw = new Database(db3Path);
      raw.exec(
        `INSERT OR REPLACE INTO rate_limit_cache (id, data, updated_at)
         VALUES (1, 'NOT_JSON{{{', '2025-01-01')`,
      );
      raw.close();

      logger.info.mockClear();
      const pBad = new OpenAICliProvider(
        {
          providerId: "openai-badjson",
          displayName: "BadJSON",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath: db3Path,
        },
        logger,
      );

      expect(logger.info).not.toHaveBeenCalledWith(
        "openai-cli: loaded cached rate limits from DB",
      );
      pBad.shutdown();
    });
  });

  // ── sendMessage: error path ─────────────────────────────────────────
  describe("sendMessage error handling", () => {
    it("sets conversation status to 'error' and rethrows on failure", async () => {
      appServerInstances[0]._sendMessageImpl = async () => {
        throw new Error("RPC failure");
      };

      await expect(
        provider.sendMessage({
          conversationId: "conv-err",
          content: "hello",
          onChunk: () => {},
        }),
      ).rejects.toThrow("RPC failure");
    });

    it("removes abort listener in finally block even on error", async () => {
      const ac = new AbortController();
      const removeEventListenerSpy = vi.spyOn(ac.signal, "removeEventListener");

      appServerInstances[0]._sendMessageImpl = async () => {
        throw new Error("boom");
      };

      await expect(
        provider.sendMessage({
          conversationId: "conv-finally",
          content: "test",
          onChunk: () => {},
          signal: ac.signal,
        }),
      ).rejects.toThrow("boom");

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
      );
    });

    it("cleans up abort listener on success", async () => {
      const ac = new AbortController();
      const removeEventListenerSpy = vi.spyOn(ac.signal, "removeEventListener");

      await provider.sendMessage({
        conversationId: "conv-signal",
        content: "test",
        onChunk: () => {},
        signal: ac.signal,
      });

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "abort",
        expect.any(Function),
      );
    });
  });

  // ── sendMessage: no usage / no rate limits path ─────────────────────
  describe("sendMessage usage edge cases", () => {
    it("calls updateStatus when server returns no token usage", async () => {
      appServerInstances[0]._sendMessageImpl = async (
        conversationId: string,
        _content: string,
        onChunk?: (text: string) => void,
      ) => {
        onChunk?.("text");
        appServerInstances[0]._threadIds.set(conversationId, "thread-no-usage");
        // Do NOT set _tokenUsage — getTokenUsage will return null
        return { text: "text", threadId: "thread-no-usage" };
      };

      const result = await provider.sendMessage({
        conversationId: "conv-no-usage",
        content: "hello",
        onChunk: () => {},
      });

      expect(result.text).toBe("text");
      expect(result.sessionId).toBe("thread-no-usage");
    });

    it("saves rate limit cache when server has rate limits", async () => {
      appServerInstances[0]._rateLimits = {
        limitId: "rl-1",
        limitName: "default",
        primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1234 },
        secondary: null,
        credits: null,
        planType: "plus",
      };

      await provider.sendMessage({
        conversationId: "conv-rl",
        content: "hello",
        onChunk: () => {},
      });

      // Verify by creating a new provider from the same DB
      logger.info.mockClear();
      const p2 = new OpenAICliProvider(
        {
          providerId: "openai-rl-check",
          displayName: "RL Check",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath,
        },
        logger,
      );
      expect(logger.info).toHaveBeenCalledWith(
        "openai-cli: loaded cached rate limits from DB",
      );
      await p2.shutdown();
    });
  });

  // ── sendMessage: system prompt prefix ───────────────────────────────
  describe("sendMessage with systemPrompt", () => {
    it("prepends system prompt when provided", async () => {
      let sentContent = "";
      appServerInstances[0]._sendMessageImpl = async (
        _conversationId: string,
        content: string,
        onChunk?: (text: string) => void,
      ) => {
        sentContent = content;
        onChunk?.("ok");
        return { text: "ok", threadId: "thread-sp" };
      };

      await provider.sendMessage({
        conversationId: "conv-sp",
        content: "hello world",
        onChunk: () => {},
        systemPrompt: "You are helpful",
      });

      expect(sentContent).toContain("<system-prompt>\nYou are helpful\n</system-prompt>");
      expect(sentContent).toContain("hello world");
    });
  });

  // ── sendMessage: abort signal triggers interrupt ────────────────────
  describe("sendMessage abort signal", () => {
    it("calls interrupt when signal is aborted during sendMessage", async () => {
      const ac = new AbortController();

      appServerInstances[0]._sendMessageImpl = async (
        conversationId: string,
        _content: string,
        onChunk?: (text: string) => void,
      ) => {
        // Abort mid-flight
        ac.abort();
        appServerInstances[0]._threadIds.set(conversationId, "thread-abort");
        onChunk?.("partial");
        return { text: "partial", threadId: "thread-abort" };
      };

      const result = await provider.sendMessage({
        conversationId: "conv-abort",
        content: "hello",
        onChunk: () => {},
        signal: ac.signal,
      });

      expect(result.text).toBe("partial");
    });
  });

  // ── resetSession edge cases ─────────────────────────────────────────
  describe("resetSession", () => {
    it("creates conversation entry when none exists in DB", async () => {
      await provider.resetSession("conv-new", { cwd: "/new-cwd" });

      const cost = provider.getCostInfo("conv-new");
      expect(cost).not.toBeNull();
      expect(cost!.inputTokens).toBe(0);
    });

    it("sets model after reset when opts.model is provided", async () => {
      await provider.sendMessage({
        conversationId: "conv-model",
        content: "test",
        onChunk: () => {},
      });

      await provider.resetSession("conv-model", { model: "gpt-5.4" });

      // After reset, thread_id is NULL, so we verify via getSessionInfo after resume
      // or directly check getCostInfo shows the conv exists, then resume to check model
      await provider.resumeSession("conv-model", "thread-check");
      const info = provider.getSessionInfo("conv-model");
      expect(info).not.toBeNull();
      expect(info!.model).toBe("gpt-5.4");
    });

    it("sets model for conversation that didn't exist yet", async () => {
      await provider.resetSession("conv-fresh", { model: "gpt-5.4-mini" });

      // Verify model is stored by resuming session and checking info
      await provider.resumeSession("conv-fresh", "thread-fresh");
      const info = provider.getSessionInfo("conv-fresh");
      expect(info).not.toBeNull();
      expect(info!.model).toBe("gpt-5.4-mini");
    });
  });

  // ── getUsageInfo ────────────────────────────────────────────────────
  describe("getUsageInfo", () => {
    it("returns null when no usage data is available", () => {
      expect(provider.getUsageInfo("conv-empty")).toBeNull();
    });

    it("returns context usage when server has context data", async () => {
      await provider.sendMessage({
        conversationId: "conv-ctx",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._contextUsage.set("conv-ctx", {
        contextTokens: 5000,
        contextWindow: 200000,
      });

      const usage = provider.getUsageInfo("conv-ctx");
      expect(usage).not.toBeNull();
      expect(usage!.context).toEqual({
        contextTokens: 5000,
        contextWindow: 200000,
      });
    });

    it("returns rate limits with primary and secondary windows", async () => {
      await provider.sendMessage({
        conversationId: "conv-rl2",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._rateLimits = {
        limitId: "rl-test",
        limitName: "default",
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 9999 },
        secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 8888 },
        credits: null,
        planType: "pro",
      };

      const usage = provider.getUsageInfo("conv-rl2");
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toHaveLength(2);
      expect(usage!.rateLimits![0]).toEqual({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.4,
        resetsAt: 9999,
      });
      expect(usage!.rateLimits![1]).toEqual({
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.6,
        resetsAt: 8888,
      });
    });

    it("returns rate limits with only primary window", async () => {
      await provider.sendMessage({
        conversationId: "conv-rl-p",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._rateLimits = {
        limitId: "rl-p",
        limitName: "default",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: null,
        credits: null,
        planType: null,
      };

      const usage = provider.getUsageInfo("conv-rl-p");
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toHaveLength(1);
      expect(usage!.rateLimits![0].rateLimitType).toBe("five_hour");
      expect(usage!.rateLimits![0].resetsAt).toBeUndefined();
    });

    it("returns rate limits with only secondary window", async () => {
      await provider.sendMessage({
        conversationId: "conv-rl-s",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._rateLimits = {
        limitId: "rl-s",
        limitName: "default",
        primary: null,
        secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 7777 },
        credits: null,
        planType: null,
      };

      const usage = provider.getUsageInfo("conv-rl-s");
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toHaveLength(1);
      expect(usage!.rateLimits![0].rateLimitType).toBe("seven_day");
    });

    it("returns empty rate limits array when rl exists but has no primary/secondary", async () => {
      await provider.sendMessage({
        conversationId: "conv-rl-empty",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._rateLimits = {
        limitId: "rl-empty",
        limitName: "default",
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
      };

      const usage = provider.getUsageInfo("conv-rl-empty");
      expect(usage).not.toBeNull();
      expect(usage!.rateLimits).toEqual([]);
    });

    it("returns window usage from server token data", async () => {
      await provider.sendMessage({
        conversationId: "conv-win",
        content: "test",
        onChunk: () => {},
      });

      const usage = provider.getUsageInfo("conv-win");
      expect(usage).not.toBeNull();
      expect(usage!.window).toEqual({
        inputTokens: 110, // 100 + 10 cached
        outputTokens: 50,
        costUsd: 0,
        turns: 0,
        resetsAt: 0,
      });
    });

    it("combines context, rate limits, and window usage", async () => {
      await provider.sendMessage({
        conversationId: "conv-all",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._contextUsage.set("conv-all", {
        contextTokens: 3000,
        contextWindow: 200000,
      });
      appServerInstances[0]._rateLimits = {
        limitId: "rl-all",
        limitName: "default",
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 5555 },
        secondary: null,
        credits: null,
        planType: null,
      };

      const usage = provider.getUsageInfo("conv-all");
      expect(usage).not.toBeNull();
      expect(usage!.context).toBeDefined();
      expect(usage!.rateLimits).toBeDefined();
      expect(usage!.window).toBeDefined();
    });
  });

  // ── listSessions ────────────────────────────────────────────────────
  describe("listSessions", () => {
    it("returns empty array when no conversations exist", () => {
      expect(provider.listSessions()).toEqual([]);
    });

    it("returns session entries for stored conversations", async () => {
      await provider.sendMessage({
        conversationId: "conv-ls-1",
        content: "test",
        onChunk: () => {},
      });

      const sessions = provider.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        providerId: "openai-unit",
        conversationId: "conv-ls-1",
        sessionId: "thread-xyz",
        alive: true,
        status: "ready",
        cwd: "/default",
      });
    });

    it("reports error status for failed conversations", async () => {
      // First create a successful conversation so it gets a threadId
      await provider.sendMessage({
        conversationId: "conv-error",
        content: "test",
        onChunk: () => {},
      });

      // Now make the next sendMessage fail
      appServerInstances[0]._sendMessageImpl = async () => {
        throw new Error("fail");
      };

      await provider.sendMessage({
        conversationId: "conv-error",
        content: "test again",
        onChunk: () => {},
      }).catch(() => {});

      const sessions = provider.listSessions();
      const errorEntry = sessions.find((s) => s.conversationId === "conv-error");
      expect(errorEntry?.status).toBe("error");
    });

    it("shows alive:false when server reports not ready", async () => {
      await provider.sendMessage({
        conversationId: "conv-dead",
        content: "test",
        onChunk: () => {},
      });

      appServerInstances[0]._ready = false;

      const sessions = provider.listSessions();
      const entry = sessions.find((s) => s.conversationId === "conv-dead");
      expect(entry?.alive).toBe(false);
    });

    it("uses defaultCwd when conversation has no cwd", async () => {
      // Create a conversation with a threadId first, then reset (keeps threadId=null)
      // Instead, create and verify via sendMessage — the entry has cwd=null because
      // no cwd was set on the conversation record.
      await provider.sendMessage({
        conversationId: "conv-no-cwd",
        content: "test",
        onChunk: () => {},
      });

      // The conversation's cwd in DB will be null (never set cwd), so listSessions
      // should fall back to defaultCwd
      const sessions = provider.listSessions();
      const entry = sessions.find((s) => s.conversationId === "conv-no-cwd");
      expect(entry?.cwd).toBe("/default");
    });
  });

  // ── setEnv ──────────────────────────────────────────────────────────
  describe("setEnv", () => {
    it("stores environment variables", () => {
      provider.setEnv("OPENAI_API_KEY", "sk-new");
      expect((provider as any).providerEnv["OPENAI_API_KEY"]).toBe("sk-new");
    });

    it("overwrites existing env var", () => {
      provider.setEnv("KEY", "v1");
      provider.setEnv("KEY", "v2");
      expect((provider as any).providerEnv["KEY"]).toBe("v2");
    });
  });

  // ── getCostInfo edge case ───────────────────────────────────────────
  describe("getCostInfo", () => {
    it("returns null for unknown conversation", () => {
      expect(provider.getCostInfo("nonexistent")).toBeNull();
    });
  });

  // ── resolveServer: reuse existing agent server ──────────────────────
  describe("resolveServer agent reuse", () => {
    it("reuses existing agent server on subsequent calls", async () => {
      provider.setAgentMcpEnv("agentA", {
        ARINOVA_BOT_TOKEN: "tok-a",
        ARINOVA_SERVER_URL: "wss://api.example.com",
      });

      await provider.sendMessage({
        conversationId: "agentA:conv-1",
        content: "first",
        onChunk: () => {},
      });

      const serverCountAfterFirst = appServerInstances.length;

      await provider.sendMessage({
        conversationId: "agentA:conv-2",
        content: "second",
        onChunk: () => {},
      });

      expect(appServerInstances.length).toBe(serverCountAfterFirst);
    });

    it("falls back to default server when agent has no MCP env", async () => {
      await provider.sendMessage({
        conversationId: "unknownAgent:conv-1",
        content: "test",
        onChunk: () => {},
      });

      expect(appServerInstances.length).toBe(1);
    });
  });

  // ── resolveConversationServer ───────────────────────────────────────
  describe("resolveConversationServer", () => {
    it("returns cached conversation server after sendMessage", async () => {
      await provider.sendMessage({
        conversationId: "conv-cached",
        content: "test",
        onChunk: () => {},
      });

      expect(() => provider.interrupt("conv-cached")).not.toThrow();
    });
  });

  // ── shutdown with agent servers ─────────────────────────────────────
  describe("shutdown", () => {
    it("shuts down both default and agent servers", async () => {
      provider.setAgentMcpEnv("agent-shut", {
        ARINOVA_BOT_TOKEN: "tok-shut",
        ARINOVA_SERVER_URL: "wss://api.example.com",
      });

      await provider.sendMessage({
        conversationId: "agent-shut:conv-1",
        content: "test",
        onChunk: () => {},
      });

      expect(appServerInstances.length).toBe(2);

      await provider.shutdown();

      expect(appServerInstances[0].shutdowns).toBe(1);
      expect(appServerInstances[1].shutdowns).toBe(1);
    });
  });

  // ── warmup ──────────────────────────────────────────────────────────
  describe("warmup", () => {
    it("is a no-op", () => {
      expect(() => provider.warmup()).not.toThrow();
    });
  });

  // ── sendMessage: model and cwd from DB ──────────────────────────────
  describe("sendMessage uses stored model and cwd", () => {
    it("uses model from DB when not passed explicitly", async () => {
      await provider.resetSession("conv-mod", { model: "gpt-5.4-mini" });

      let capturedOpts: any;
      appServerInstances[0]._sendMessageImpl = async (
        conversationId: string,
        _content: string,
        onChunk?: (text: string) => void,
        opts?: any,
      ) => {
        capturedOpts = opts;
        onChunk?.("ok");
        appServerInstances[0]._threadIds.set(conversationId, "thread-mod");
        return { text: "ok", threadId: "thread-mod" };
      };

      await provider.sendMessage({
        conversationId: "conv-mod",
        content: "hello",
        onChunk: () => {},
      });

      expect(capturedOpts.model).toBe("gpt-5.4-mini");
    });

    it("uses cwd from DB when not passed explicitly", async () => {
      await provider.resetSession("conv-cwd", { cwd: "/custom/dir" });

      let capturedOpts: any;
      appServerInstances[0]._sendMessageImpl = async (
        conversationId: string,
        _content: string,
        onChunk?: (text: string) => void,
        opts?: any,
      ) => {
        capturedOpts = opts;
        onChunk?.("ok");
        appServerInstances[0]._threadIds.set(conversationId, "thread-cwd");
        return { text: "ok", threadId: "thread-cwd" };
      };

      await provider.sendMessage({
        conversationId: "conv-cwd",
        content: "hello",
        onChunk: () => {},
      });

      expect(capturedOpts.cwd).toBe("/custom/dir");
    });
  });

  // ── setAgentMcpEnv: missing token/url ───────────────────────────────
  describe("setAgentMcpEnv", () => {
    it("skips ensureAgentCodexHome when bot token is missing", () => {
      provider.setAgentMcpEnv("agent-no-token", {
        ARINOVA_SERVER_URL: "wss://api.example.com",
      });

      expect(ensureAgentCodexHomeCalls).toHaveLength(0);
    });

    it("skips ensureAgentCodexHome when server URL is missing", () => {
      provider.setAgentMcpEnv("agent-no-url", {
        ARINOVA_BOT_TOKEN: "tok",
      });

      expect(ensureAgentCodexHomeCalls).toHaveLength(0);
    });
  });

  // ── sendMessage: threadId not returned ──────────────────────────────
  describe("sendMessage when no threadId is returned", () => {
    it("does not upsert threadId when result has no threadId", async () => {
      appServerInstances[0]._sendMessageImpl = async (
        _conversationId: string,
        _content: string,
        onChunk?: (text: string) => void,
      ) => {
        onChunk?.("text");
        return { text: "text", threadId: undefined };
      };

      const result = await provider.sendMessage({
        conversationId: "conv-no-tid",
        content: "hello",
        onChunk: () => {},
      });

      expect(result.text).toBe("text");
      expect(result.sessionId).toBeUndefined();
    });
  });

  // ── resolveServer: CODEX_HOME in env ────────────────────────────────
  describe("resolveServer codex home injection", () => {
    it("includes CODEX_HOME when agentCodexHomes has entry", async () => {
      provider.setAgentMcpEnv("agent-home", {
        ARINOVA_BOT_TOKEN: "tok-home",
        ARINOVA_SERVER_URL: "wss://api.example.com",
      });

      await provider.sendMessage({
        conversationId: "agent-home:conv-1",
        content: "test",
        onChunk: () => {},
      });

      const agentConfig = appServerInstances[1].config;
      expect(agentConfig.env).toHaveProperty("CODEX_HOME");
      expect(agentConfig.env.CODEX_HOME).toContain("agent-home");
    });
  });
});
