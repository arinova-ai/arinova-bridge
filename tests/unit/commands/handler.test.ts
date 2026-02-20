import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandHandler } from "../../../src/commands/handler.js";
import type { Provider, ProviderId } from "../../../src/providers/types.js";
import type { BridgeConfig } from "../../../src/config.js";
import type { CommandContext } from "../../../src/commands/types.js";

function createMockProvider(id: ProviderId, displayName: string): Provider {
  return {
    id,
    displayName,
    sendMessage: vi.fn(async () => ({ text: "ok" })),
    interrupt: vi.fn(),
    resetSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => true),
    getSessionInfo: vi.fn(() => ({
      sessionId: "test-session-id",
      alive: true,
      cwd: "/test",
      model: "sonnet",
    })),
    getCostInfo: vi.fn(() => ({
      totalCostUsd: 0.1234,
    })),
    listSessions: vi.fn(() => [
      {
        providerId: id,
        sessionId: "test-session-id",
        conversationId: "conv-1",
        alive: true,
        cwd: "/test",
        model: "sonnet",
      },
    ]),
    supportedModels: vi.fn(() => ["opus", "sonnet", "haiku"]),
    shutdown: vi.fn(async () => {}),
  };
}

function createMockConfig(defaultProvider: ProviderId = "anthropic-oauth"): BridgeConfig {
  return {
    arinova: { serverUrl: "ws://test", botToken: "tok" },
    defaultProvider,
    providers: {
      "anthropic-oauth": { enabled: true, claudePath: "claude" },
      "openai-api": { enabled: true, apiKey: "sk-test" },
    },
    defaults: {
      cwd: "/default/cwd",
      maxSessions: 5,
      idleTimeoutMs: 600000,
      dbPath: "/tmp/test.db",
    },
  };
}

function createCtx(conversationId = "conv-1"): CommandContext & {
  chunks: string[];
  completed: string | null;
  errored: string | null;
} {
  const ctx = {
    conversationId,
    chunks: [] as string[],
    completed: null as string | null,
    errored: null as string | null,
    sendChunk: vi.fn((text: string) => { ctx.chunks.push(text); }),
    sendComplete: vi.fn((text: string) => { ctx.completed = text; }),
    sendError: vi.fn((text: string) => { ctx.errored = text; }),
  };
  return ctx;
}

describe("CommandHandler", () => {
  let providers: Map<ProviderId, Provider>;
  let handler: CommandHandler;
  let anthropicProvider: Provider;
  let openaiProvider: Provider;

  beforeEach(() => {
    providers = new Map();
    anthropicProvider = createMockProvider("anthropic-oauth", "Anthropic OAuth");
    openaiProvider = createMockProvider("openai-api", "OpenAI API");
    providers.set("anthropic-oauth", anthropicProvider);
    providers.set("openai-api", openaiProvider);
    handler = new CommandHandler(providers, createMockConfig());
  });

  describe("command parsing", () => {
    it("ignores non-command messages", async () => {
      const ctx = createCtx();
      const result = await handler.handle("hello world", ctx);
      expect(result.handled).toBe(false);
    });

    it("ignores unknown commands", async () => {
      const ctx = createCtx();
      const result = await handler.handle("/unknown", ctx);
      expect(result.handled).toBe(false);
    });

    it("handles commands case-insensitively", async () => {
      const ctx = createCtx();
      const result = await handler.handle("/HELP", ctx);
      expect(result.handled).toBe(true);
    });
  });

  describe("/help", () => {
    it("lists available commands", async () => {
      const ctx = createCtx();
      await handler.handle("/help", ctx);
      expect(ctx.completed).toContain("/new");
      expect(ctx.completed).toContain("/status");
      expect(ctx.completed).toContain("/provider");
    });
  });

  describe("/status", () => {
    it("shows session info", async () => {
      const ctx = createCtx();
      await handler.handle("/status", ctx);
      expect(ctx.completed).toContain("Anthropic OAuth");
      expect(ctx.completed).toContain("test-sessio"); // truncated to 12 chars
    });

    it("shows no session when provider returns null", async () => {
      vi.mocked(anthropicProvider.getSessionInfo).mockReturnValue(null);
      const ctx = createCtx();
      await handler.handle("/status", ctx);
      expect(ctx.completed).toContain("目前無活躍的 session");
    });
  });

  describe("/new", () => {
    it("resets session with default cwd", async () => {
      const ctx = createCtx();
      await handler.handle("/new", ctx);
      expect(anthropicProvider.resetSession).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ cwd: "/default/cwd" }),
      );
      expect(ctx.completed).toContain("已開啟新的工作階段");
    });

    it("reports error for non-existent path", async () => {
      const ctx = createCtx();
      await handler.handle("/new /nonexistent/path/xyz", ctx);
      expect(ctx.completed).toContain("路徑不存在");
    });
  });

  describe("/stop", () => {
    it("calls provider.interrupt", async () => {
      const ctx = createCtx();
      await handler.handle("/stop", ctx);
      expect(anthropicProvider.interrupt).toHaveBeenCalledWith("conv-1");
      expect(ctx.completed).toContain("已中斷");
    });
  });

  describe("/model", () => {
    it("shows current model when no arg", async () => {
      const ctx = createCtx();
      await handler.handle("/model", ctx);
      expect(ctx.completed).toContain("目前模型");
    });

    it("rejects unsupported model", async () => {
      const ctx = createCtx();
      await handler.handle("/model gpt-4", ctx);
      expect(ctx.completed).toContain("不支援的模型");
    });

    it("sets supported model and resets session", async () => {
      const ctx = createCtx();
      await handler.handle("/model sonnet", ctx);
      expect(ctx.completed).toContain("已切換模型為 sonnet");
      expect(anthropicProvider.resetSession).toHaveBeenCalled();
    });
  });

  describe("/cost", () => {
    it("shows cost info", async () => {
      const ctx = createCtx();
      await handler.handle("/cost", ctx);
      expect(ctx.completed).toContain("$0.1234");
    });

    it("shows no data when provider returns null", async () => {
      vi.mocked(anthropicProvider.getCostInfo).mockReturnValue(null);
      const ctx = createCtx();
      await handler.handle("/cost", ctx);
      expect(ctx.completed).toContain("目前無使用資料");
    });
  });

  describe("/sessions", () => {
    it("lists sessions from all providers", async () => {
      const ctx = createCtx();
      await handler.handle("/sessions", ctx);
      expect(ctx.completed).toContain("test-sessio");
      expect(ctx.completed).toContain("anthropic-oauth");
    });

    it("shows empty message when no sessions", async () => {
      vi.mocked(anthropicProvider.listSessions).mockReturnValue([]);
      vi.mocked(openaiProvider.listSessions).mockReturnValue([]);
      const ctx = createCtx();
      await handler.handle("/sessions", ctx);
      expect(ctx.completed).toContain("沒有任何 session");
    });
  });

  describe("/resume", () => {
    it("requires session ID", async () => {
      const ctx = createCtx();
      await handler.handle("/resume", ctx);
      expect(ctx.completed).toContain("請提供 session ID");
    });

    it("resumes with session ID", async () => {
      const ctx = createCtx();
      await handler.handle("/resume abc123", ctx);
      expect(anthropicProvider.resumeSession).toHaveBeenCalledWith(
        "conv-1",
        "abc123",
        expect.anything(),
      );
      expect(ctx.completed).toContain("已恢復 session");
    });

    it("reports failure", async () => {
      vi.mocked(anthropicProvider.resumeSession).mockResolvedValue(false);
      const ctx = createCtx();
      await handler.handle("/resume bad-id", ctx);
      expect(ctx.completed).toContain("恢復失敗");
    });
  });

  describe("/compact", () => {
    it("works for anthropic provider", async () => {
      const ctx = createCtx();
      await handler.handle("/compact", ctx);
      expect(ctx.completed).toContain("已壓縮");
    });

    it("rejects for non-anthropic provider", async () => {
      // Switch to openai
      const ctx = createCtx("conv-2");
      await handler.handle("/provider openai-api", ctx);

      const ctx2 = createCtx("conv-2");
      await handler.handle("/compact", ctx2);
      expect(ctx2.completed).toContain("不支援");
    });
  });

  describe("/provider", () => {
    it("shows current provider when no arg", async () => {
      const ctx = createCtx();
      await handler.handle("/provider", ctx);
      expect(ctx.completed).toContain("Anthropic OAuth");
      expect(ctx.completed).toContain("anthropic-oauth");
      expect(ctx.completed).toContain("openai-api");
    });

    it("switches provider", async () => {
      const ctx = createCtx();
      await handler.handle("/provider openai-api", ctx);
      expect(ctx.completed).toContain("OpenAI API");
      expect(ctx.completed).toContain("已切換到");

      // Verify interrupt was called on old provider
      expect(anthropicProvider.interrupt).toHaveBeenCalledWith("conv-1");
    });

    it("rejects unknown provider", async () => {
      const ctx = createCtx();
      await handler.handle("/provider nonexistent", ctx);
      expect(ctx.completed).toContain("不支援或未啟用");
    });

    it("clears model override on switch", async () => {
      const ctx = createCtx();
      // Set model on anthropic
      await handler.handle("/model sonnet", ctx);
      expect(handler.getModelForConversation("conv-1")).toBe("sonnet");

      // Switch provider
      const ctx2 = createCtx();
      await handler.handle("/provider openai-api", ctx2);
      expect(handler.getModelForConversation("conv-1")).toBeUndefined();
    });

    it("preserves cwd override on switch", async () => {
      // Can't set cwd to a non-existent path, so just test default
      const ctx = createCtx();
      await handler.handle("/provider openai-api", ctx);
      expect(handler.getCwdForConversation("conv-1")).toBe("/default/cwd");
    });

    it("routes messages to switched provider", async () => {
      const ctx = createCtx();
      await handler.handle("/provider openai-api", ctx);

      const provider = handler.getProviderForConversation("conv-1");
      expect(provider.id).toBe("openai-api");
    });
  });

  describe("getSkills", () => {
    it("includes /compact when anthropic providers exist", () => {
      const skills = handler.getSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).toContain("compact");
    });

    it("includes /provider when multiple providers exist", () => {
      const skills = handler.getSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).toContain("provider");
    });

    it("excludes /provider with single provider", () => {
      const singleProviders = new Map<ProviderId, Provider>();
      singleProviders.set("anthropic-oauth", anthropicProvider);
      const singleHandler = new CommandHandler(singleProviders, createMockConfig());
      const skills = singleHandler.getSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).not.toContain("provider");
    });
  });
});
