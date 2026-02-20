import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock codex process module
vi.mock("../../../src/codex/process.js", () => ({
  resolveCodexBinary: vi.fn((p?: string) => p || "/usr/bin/codex"),
  spawnCodexExec: vi.fn(() => createMockCodexProcess()),
  spawnCodexResume: vi.fn(() => createMockCodexProcess()),
  interruptProcess: vi.fn(),
  waitForExit: vi.fn(async () => ({ code: 0, signal: null })),
}));

// Mock the events module processTurn
vi.mock("../../../src/codex/events.js", async () => {
  const actual = await vi.importActual("../../../src/codex/events.js");
  return {
    ...actual,
    processTurn: vi.fn(async (_events: any, sink: any) => {
      sink.onChunk("Codex says hello");
      sink.onComplete("Codex says hello");
      return {
        threadId: "thread-xyz",
        finalResponse: "Codex says hello",
        usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 },
      };
    }),
  };
});

function createMockCodexProcess() {
  return {
    child: {
      pid: 12345,
      killed: false,
      exitCode: null,
      kill: vi.fn(),
    },
    events: (async function* () {})(),
    stderr: () => "",
  };
}

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
    it("returns null (no validation)", () => {
      expect(provider.supportedModels()).toBeNull();
    });
  });
});
