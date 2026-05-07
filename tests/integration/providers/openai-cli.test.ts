import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const appServerInstances = vi.hoisted(() => [] as Array<{ config: any }>);

vi.mock("../../../src/codex/app-server.js", () => ({
  CodexAppServer: class {
    private threadIds = new Map<string, string>();
    private usage = new Map<string, {
      total: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
      };
    }>();

    constructor(config: any) {
      appServerInstances.push({ config });
    }

    async sendMessage(
      conversationId: string,
      _content: string,
      onChunk?: (text: string) => void,
    ) {
      onChunk?.("Codex says hello");
      this.threadIds.set(conversationId, "thread-xyz");
      this.usage.set(conversationId, {
        total: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 50,
        },
      });
      return { text: "Codex says hello", threadId: "thread-xyz" };
    }

    interrupt() {}
    clearThread(conversationId: string) { this.threadIds.delete(conversationId); }
    getThreadId(conversationId: string) { return this.threadIds.get(conversationId) ?? null; }
    getTokenUsage(conversationId: string) { return this.usage.get(conversationId) ?? null; }
    getContextUsage() { return null; }
    getRateLimits() { return null; }
    isReady() { return true; }
    async shutdown() {}
  },
}));

import { OpenAICliProvider } from "../../../src/providers/openai-cli.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("OpenAICliProvider", () => {
  let provider: OpenAICliProvider;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    appServerInstances.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arinova-test-openai-"));
    dbPath = path.join(tmpDir, "test.db");

    provider = new OpenAICliProvider(
      {
        providerId: "openai-api",
        displayName: "OpenAI API",
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

  it("has correct id and displayName", () => {
    expect(provider.id).toBe("openai-api");
    expect(provider.displayName).toBe("OpenAI API");
  });

  describe("sendMessage", () => {
    it("spawns codex and returns result", async () => {
      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-1",
        content: "Hello codex",
        onChunk: (text) => chunks.push(text),
      });

      expect(result.text).toBe("Codex says hello");
      expect(result.sessionId).toBe("thread-xyz");
      expect(chunks).toContain("Codex says hello");
    });
  });

  describe("interrupt", () => {
    it("does not throw for non-active conversation", () => {
      expect(() => provider.interrupt("conv-999")).not.toThrow();
    });
  });

  describe("resetSession", () => {
    it("resets conversation in DB", async () => {
      // Create a session first
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      await provider.resetSession("conv-1", { cwd: "/new-dir" });

      const info = provider.getSessionInfo("conv-1");
      // After reset, thread_id should be null
      expect(info).toBeNull();
    });
  });

  describe("resumeSession", () => {
    it("sets thread ID for resume", async () => {
      const ok = await provider.resumeSession("conv-1", "thread-old");
      expect(ok).toBe(true);

      const info = provider.getSessionInfo("conv-1");
      expect(info).not.toBeNull();
      expect(info!.sessionId).toBe("thread-old");
    });
  });

  describe("getSessionInfo", () => {
    it("returns null for unknown conversation", () => {
      expect(provider.getSessionInfo("conv-999")).toBeNull();
    });

    it("returns info after message", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const info = provider.getSessionInfo("conv-1");
      expect(info).not.toBeNull();
      expect(info!.sessionId).toBe("thread-xyz");
    });
  });

  describe("getCostInfo", () => {
    it("returns token usage", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const cost = provider.getCostInfo("conv-1");
      expect(cost).not.toBeNull();
      expect(cost!.inputTokens).toBe(100);
      expect(cost!.cachedInputTokens).toBe(10);
      expect(cost!.outputTokens).toBe(50);
    });
  });

  describe("supportedModels", () => {
    it("returns known model list", () => {
      const models = provider.supportedModels();
      expect(models).toBeInstanceOf(Array);
      expect(models!.length).toBeGreaterThan(0);
      expect(models).toContain("gpt-5.1-codex-mini");
    });

    it("returns custom models when configured", () => {
      const customProvider = new OpenAICliProvider(
        {
          providerId: "custom-openai",
          displayName: "Custom OpenAI",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath: path.join(tmpDir, "custom.db"),
          models: ["custom-model-1", "custom-model-2"],
        },
        logger,
      );
      expect(customProvider.supportedModels()).toEqual(["custom-model-1", "custom-model-2"]);
    });
  });

  describe("env injection", () => {
    it("creates provider with custom env vars", () => {
      const envProvider = new OpenAICliProvider(
        {
          providerId: "openai-custom",
          displayName: "OpenAI Custom",
          codexPath: "/usr/bin/codex",
          defaultCwd: "/default",
          dbPath: path.join(tmpDir, "env.db"),
          env: {
            OPENAI_BASE_URL: "https://custom-api.example.com",
            OPENAI_API_KEY: "sk-custom",
          },
        },
        logger,
      );
      expect(envProvider.id).toBe("openai-custom");
      expect(envProvider.type).toBe("openai-cli");
      expect(envProvider.displayName).toBe("OpenAI Custom");
    });

    it("creates an agent-scoped app server with that agent's MCP token", async () => {
      provider.setAgentMcpEnv("casey", {
        ARINOVA_BOT_TOKEN: "ari_casey",
        ARINOVA_SERVER_URL: "wss://api.example.com",
      });

      await provider.sendMessage({
        conversationId: "casey:default",
        content: "test",
        onChunk: () => {},
      });

      expect(appServerInstances).toHaveLength(2);
      expect(appServerInstances[1].config.env).toMatchObject({
        ARINOVA_BOT_TOKEN: "ari_casey",
        ARINOVA_SERVER_URL: "wss://api.example.com",
      });
    });
  });
});
