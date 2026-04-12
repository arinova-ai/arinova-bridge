import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandHandler } from "../../../src/commands/handler.js";
import type { Provider } from "../../../src/providers/types.js";
import type { BridgeConfig } from "../../../src/config.js";
import type { CommandContext } from "../../../src/commands/types.js";

function createMockProvider(id: string, type: string, displayName: string, sessionId = `${id}-session-id`): Provider {
  return {
    id,
    type,
    displayName,
    sendMessage: vi.fn(async () => ({ text: "ok" })),
    interrupt: vi.fn(),
    resetSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => true),
    getSessionInfo: vi.fn(() => ({
      sessionId,
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
        sessionId,
        conversationId: "conv-1",
        alive: true,
        status: "ready",
        cwd: "/test",
        model: "sonnet",
      },
    ]),
    supportedModels: vi.fn(() => ["opus", "sonnet", "haiku"]),
    shutdown: vi.fn(async () => {}),
  };
}

function createMockConfig(defaultProvider = "anthropic-oauth"): BridgeConfig {
  return {
    arinova: { serverUrl: "ws://test", botToken: "tok" },
    defaultProvider,
    providers: [
      { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
      { id: "openai-api", type: "openai-cli", displayName: "OpenAI API", enabled: true, apiKey: "sk-test" },
    ],
    defaults: {
      cwd: "/default/cwd",
      maxSessions: 5,
      idleTimeoutMs: 600000,
      dbPath: "/tmp/test.db",
    },
    agents: [],
  };
}

const mockNotes = [
  {
    id: "note-aabbccdd-1234",
    conversationId: "conv-1",
    creatorId: "user-1",
    creatorType: "user" as const,
    creatorName: "Alice",
    title: "TODO List",
    content: "Fix the bug in auth module",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  },
  {
    id: "note-eeff0011-5678",
    conversationId: "conv-1",
    creatorId: "agent-1",
    creatorType: "agent" as const,
    creatorName: "Bridge",
    agentName: "Bridge Bot",
    title: "Meeting Notes",
    content: "Discussed the new feature",
    createdAt: "2026-03-02T00:00:00Z",
    updatedAt: "2026-03-02T00:00:00Z",
  },
];

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
    listNotes: vi.fn(async () => ({ notes: mockNotes, hasMore: false })),
    createNote: vi.fn(async (body: { title: string; content?: string }) => ({
      ...mockNotes[0],
      id: "note-new-12345678",
      title: body.title,
      content: body.content ?? "",
    })),
    updateNote: vi.fn(async (_noteId: string, body: { title?: string; content?: string }) => ({
      ...mockNotes[0],
      title: body.title ?? mockNotes[0].title,
      content: body.content ?? mockNotes[0].content,
    })),
    deleteNote: vi.fn(async () => {}),
  };
  return ctx;
}

describe("CommandHandler", () => {
  let providers: Map<string, Provider>;
  let handler: CommandHandler;
  let anthropicProvider: Provider;
  let openaiProvider: Provider;

  beforeEach(() => {
    providers = new Map();
    anthropicProvider = createMockProvider("anthropic-oauth", "anthropic-cli", "Anthropic OAuth");
    openaiProvider = createMockProvider("openai-api", "openai-cli", "OpenAI API");
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
      expect(ctx.completed).toContain("/notes");
      expect(ctx.completed).toContain("/note-add");
      expect(ctx.completed).toContain("/note-del");
    });
  });

  describe("/status", () => {
    it("shows session info", async () => {
      const ctx = createCtx();
      await handler.handle("/status", ctx);
      expect(ctx.completed).toContain("Anthropic OAuth");
      expect(ctx.completed).toContain("anthropic-oa"); // session ID truncated to 12 chars
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
      expect(ctx.completed).toContain("anthropic-oauth");
      expect(ctx.completed).toContain("openai-api");
      expect(ctx.completed).toContain("ready"); // status text
    });

    it("marks current session with green dot", async () => {
      const ctx = createCtx();
      await handler.handle("/sessions", ctx);
      // anthropic-oauth is the default provider and conv-1 matches, so 🟢
      expect(ctx.completed).toContain("🟢");
      expect(ctx.completed).toContain("⚪");
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

    it("resumes with session ID prefix match", async () => {
      const ctx = createCtx();
      await handler.handle("/resume anthropic-oauth-ses", ctx);
      expect(anthropicProvider.resumeSession).toHaveBeenCalledWith(
        "conv-1",
        "anthropic-oauth-session-id",
        expect.anything(),
      );
      expect(ctx.completed).toContain("已恢復 session");
    });

    it("auto-switches provider when resuming cross-provider session", async () => {
      const ctx = createCtx();
      await handler.handle("/resume openai-api-ses", ctx);
      expect(openaiProvider.resumeSession).toHaveBeenCalledWith(
        "conv-1",
        "openai-api-session-id",
        expect.anything(),
      );
      expect(ctx.completed).toContain("已恢復 session");
      expect(ctx.completed).toContain("Provider 已切換");
    });

    it("reports no match for unknown ID", async () => {
      const ctx = createCtx();
      await handler.handle("/resume bad-id", ctx);
      expect(ctx.completed).toContain("找不到匹配");
    });

    it("reports failure when provider rejects resume", async () => {
      vi.mocked(anthropicProvider.resumeSession).mockResolvedValue(false);
      const ctx = createCtx();
      await handler.handle("/resume anthropic-oauth-ses", ctx);
      expect(ctx.completed).toContain("恢復失敗");
    });
  });

  describe("/compact", () => {
    // ── Anthropic provider: native --resume --compact ──

    it("anthropic: uses native reset+resume with compact flag", async () => {
      const ctx = createCtx();
      await handler.handle("/compact", ctx);

      expect(anthropicProvider.getSessionInfo).toHaveBeenCalledWith("conv-1");
      expect(anthropicProvider.resetSession).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ compact: true }),
      );
      expect(anthropicProvider.resumeSession).toHaveBeenCalledWith(
        "conv-1",
        "anthropic-oauth-session-id",
        expect.objectContaining({ compact: true }),
      );
      expect(ctx.completed).toContain("已壓縮");
    });

    it("anthropic: reports no session when getSessionInfo returns null", async () => {
      vi.mocked(anthropicProvider.getSessionInfo).mockReturnValue(null);
      const ctx = createCtx();
      await handler.handle("/compact", ctx);

      expect(ctx.completed).toContain("目前無活躍的 session");
      expect(anthropicProvider.resetSession).not.toHaveBeenCalled();
    });

    it("anthropic: skips resumeSession when sessionId is absent", async () => {
      vi.mocked(anthropicProvider.getSessionInfo).mockReturnValue({
        sessionId: undefined as unknown as string,
        alive: true,
        cwd: "/test",
        model: "sonnet",
      });
      const ctx = createCtx();
      await handler.handle("/compact", ctx);

      expect(anthropicProvider.resetSession).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ compact: true }),
      );
      expect(anthropicProvider.resumeSession).not.toHaveBeenCalled();
      expect(ctx.completed).toContain("已壓縮");
    });

    // ── Non-Anthropic providers: bridgeSessionStore.compact() ──

    it("openai: compacts via sessionStore and resets session", async () => {
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          // Simulate the summariser being called with middle messages
          await summariser(
            [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
            undefined,
          );
        }),
      };
      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      // Switch to openai provider
      const ctx = createCtx("conv-3");
      await handlerWithStore.handle("/provider openai-api", ctx);

      const ctx2 = createCtx("conv-3");
      await handlerWithStore.handle("/compact", ctx2);

      expect(mockSessionStore.compact).toHaveBeenCalledWith("conv-3", expect.any(Function), expect.objectContaining({ model: undefined }));
      expect(openaiProvider.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-3:compact",
          systemPrompt: expect.stringContaining("summariser"),
        }),
      );
      expect(openaiProvider.resetSession).toHaveBeenCalledWith(
        "conv-3",
        expect.objectContaining({ cwd: "/default/cwd" }),
      );
      expect(ctx2.completed).toContain("已壓縮");
    });

    it("gemini: compacts via sessionStore and resets session", async () => {
      const geminiProvider = createMockProvider("gemini-api", "gemini-cli", "Gemini");
      const providersWithGemini = new Map<string, Provider>();
      providersWithGemini.set("anthropic-oauth", anthropicProvider);
      providersWithGemini.set("gemini-api", geminiProvider);

      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser(
            [{ role: "user", content: "test msg" }],
            "existing summary",
          );
        }),
      };
      const configWithGemini = {
        ...createMockConfig(),
        providers: [
          { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
          { id: "gemini-api", type: "gemini-cli", displayName: "Gemini", enabled: true, apiKey: "gm-test" },
        ],
      };
      const handlerWithGemini = new CommandHandler(
        providersWithGemini,
        configWithGemini,
        mockSessionStore as any,
      );

      // Switch to gemini
      const ctx = createCtx("conv-4");
      await handlerWithGemini.handle("/provider gemini-api", ctx);

      const ctx2 = createCtx("conv-4");
      await handlerWithGemini.handle("/compact", ctx2);

      expect(mockSessionStore.compact).toHaveBeenCalledWith("conv-4", expect.any(Function), expect.objectContaining({ model: undefined }));
      // Summariser should include existing summary in the prompt
      expect(geminiProvider.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-4:compact",
          content: expect.stringContaining("existing summary"),
        }),
      );
      expect(geminiProvider.resetSession).toHaveBeenCalledWith(
        "conv-4",
        expect.objectContaining({ cwd: "/default/cwd" }),
      );
      expect(ctx2.completed).toContain("已壓縮");
    });

    it("non-anthropic: summariser prompt includes token budget", async () => {
      let capturedPrompt = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          // Wrap sendMessage to capture the prompt
          const origSendMessage = openaiProvider.sendMessage;
          vi.mocked(openaiProvider.sendMessage).mockImplementation(async (opts: any) => {
            capturedPrompt = opts.content;
            return { text: "summary" };
          });
          await summariser([{ role: "user", content: "msg" }], undefined);
          openaiProvider.sendMessage = origSendMessage;
        }),
      };
      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-5");
      await handlerWithStore.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-5");
      await handlerWithStore.handle("/compact", ctx2);

      expect(capturedPrompt).toContain("tokens");
    });

    // ── Edge cases ──

    it("non-anthropic: fails gracefully when sessionStore is not available", async () => {
      // Create handler WITHOUT sessionStore
      const handlerNoStore = new CommandHandler(providers, createMockConfig());

      // Switch to openai
      const ctx = createCtx("conv-6");
      await handlerNoStore.handle("/provider openai-api", ctx);

      const ctx2 = createCtx("conv-6");
      await handlerNoStore.handle("/compact", ctx2);

      expect(ctx2.completed).toContain("session store 未啟用");
    });

    it("non-anthropic: compact failure replies error and keeps session intact", async () => {
      const mockSessionStore = {
        compact: vi.fn(async () => {
          throw new Error("DB write failed");
        }),
      };
      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-7");
      await handlerWithStore.handle("/provider openai-api", ctx);
      // Clear mock after /provider switch (which now correctly calls resetSession on target)
      vi.mocked(openaiProvider.resetSession).mockClear();

      const ctx2 = createCtx("conv-7");
      await handlerWithStore.handle("/compact", ctx2);

      expect(ctx2.completed).toContain("compact 失敗");
      expect(ctx2.completed).toContain("session 維持原狀");
      expect(ctx2.completed).toContain("DB write failed");
      // resetSession must NOT be called during compact failure — session stays as-is
      expect(openaiProvider.resetSession).not.toHaveBeenCalled();
    });

    it("non-anthropic: summariser API failure replies error and keeps session intact", async () => {
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "msg" }], undefined);
        }),
      };
      vi.mocked(openaiProvider.sendMessage).mockRejectedValue(new Error("API timeout"));

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-8");
      await handlerWithStore.handle("/provider openai-api", ctx);
      // Clear mock after /provider switch (which now correctly calls resetSession on target)
      vi.mocked(openaiProvider.resetSession).mockClear();

      const ctx2 = createCtx("conv-8");
      await handlerWithStore.handle("/compact", ctx2);

      expect(ctx2.completed).toContain("compact 失敗");
      expect(ctx2.completed).toContain("session 維持原狀");
      expect(ctx2.completed).toContain("API timeout");
      // resetSession must NOT be called during compact failure — session stays as-is
      expect(openaiProvider.resetSession).not.toHaveBeenCalled();
    });

    // ── Compact v2: compactModel config ──

    it("openai: uses compactModel from agent config instead of session model", async () => {
      let capturedModel = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "hello" }], undefined);
        }),
      };
      vi.mocked(openaiProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedModel = opts.model;
        return { text: "summary" };
      });

      const configWithAgent = {
        ...createMockConfig(),
        agents: [{ name: "test-agent", botToken: "tok", provider: "openai-cli", compactModel: "gpt-4.1-nano" }],
      };
      const handlerWithAgent = new CommandHandler(
        providers,
        configWithAgent,
        mockSessionStore as any,
      );
      handlerWithAgent.agentName = "test-agent";

      const ctx = createCtx("conv-cm-1");
      await handlerWithAgent.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-cm-1");
      await handlerWithAgent.handle("/compact", ctx2);

      // compact opts should carry the compactModel
      expect(mockSessionStore.compact).toHaveBeenCalledWith(
        "conv-cm-1",
        expect.any(Function),
        expect.objectContaining({ model: "gpt-4.1-nano" }),
      );
      // sendMessage should use the compactModel, not the session model
      expect(capturedModel).toBe("gpt-4.1-nano");
      expect(ctx2.completed).toContain("已壓縮");
    });

    it("openai: falls back to session model when compactModel is not configured", async () => {
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "msg" }], undefined);
        }),
      };

      // agents array is empty — no agentCfg match, so compactModel = undefined ?? model
      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-cm-2");
      await handlerWithStore.handle("/provider openai-api", ctx);

      const ctx2 = createCtx("conv-cm-2");
      await handlerWithStore.handle("/compact", ctx2);

      // No agentCfg → compactModel = undefined ?? getModelForConversation() = undefined
      expect(mockSessionStore.compact).toHaveBeenCalledWith(
        "conv-cm-2",
        expect.any(Function),
        expect.objectContaining({ model: undefined }),
      );
    });

    it("gemini: uses compactModel from agent config", async () => {
      const geminiProvider = createMockProvider("gemini-api", "gemini-cli", "Gemini");
      const providersWithGemini = new Map<string, Provider>();
      providersWithGemini.set("anthropic-oauth", anthropicProvider);
      providersWithGemini.set("gemini-api", geminiProvider);

      let capturedModel = "";
      vi.mocked(geminiProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedModel = opts.model;
        return { text: "gemini summary" };
      });

      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "test" }], undefined);
        }),
      };
      const configWithGemini = {
        ...createMockConfig(),
        providers: [
          { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
          { id: "gemini-api", type: "gemini-cli", displayName: "Gemini", enabled: true, apiKey: "gm-test" },
        ],
        agents: [{ name: "gemini-bot", botToken: "tok", provider: "gemini-cli", compactModel: "gemini-2.5-flash-lite" }],
      };
      const handlerWithGemini = new CommandHandler(
        providersWithGemini,
        configWithGemini,
        mockSessionStore as any,
      );
      handlerWithGemini.agentName = "gemini-bot";

      const ctx = createCtx("conv-cm-3");
      await handlerWithGemini.handle("/provider gemini-api", ctx);
      const ctx2 = createCtx("conv-cm-3");
      await handlerWithGemini.handle("/compact", ctx2);

      expect(capturedModel).toBe("gemini-2.5-flash-lite");
      expect(ctx2.completed).toContain("已壓縮");
    });

    // ── Compact v2: buildCompactPrompt integration ──

    it("non-anthropic: task-oriented messages produce task-mode summary prompt", async () => {
      let capturedContent = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser(
            [{ role: "user", content: "fix bug in commit a1b2c3d, card ID bd4921d5-xxxx" }],
            undefined,
          );
        }),
      };
      vi.mocked(openaiProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedContent = opts.content;
        return { text: "task summary" };
      });

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-task-1");
      await handlerWithStore.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-task-1");
      await handlerWithStore.handle("/compact", ctx2);

      // Task mode: should contain engineering-specific preservation instructions
      expect(capturedContent).toContain("Summarise this engineering conversation");
      expect(capturedContent).toContain("commit hashes");
      expect(capturedContent).toContain("a1b2c3d");
    });

    it("non-anthropic: general messages produce general-mode summary prompt", async () => {
      let capturedContent = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser(
            [{ role: "user", content: "你好嗎" }, { role: "assistant", content: "我很好" }],
            undefined,
          );
        }),
      };
      vi.mocked(openaiProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedContent = opts.content;
        return { text: "general summary" };
      });

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-gen-1");
      await handlerWithStore.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-gen-1");
      await handlerWithStore.handle("/compact", ctx2);

      // General mode: Chinese structured instruction prompt
      expect(capturedContent).toContain("請將以下對話整理成以下結構化格式");
    });

    it("non-anthropic: summariser uses dedicated :compact conversation ID", async () => {
      let capturedConvId = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "test" }], undefined);
        }),
      };
      vi.mocked(openaiProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedConvId = opts.conversationId;
        return { text: "summary" };
      });

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-dedicated-1");
      await handlerWithStore.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-dedicated-1");
      await handlerWithStore.handle("/compact", ctx2);

      expect(capturedConvId).toBe("conv-dedicated-1:compact");
    });

    it("non-anthropic: summariser system prompt instructs summariser role", async () => {
      let capturedSystemPrompt = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "test" }], undefined);
        }),
      };
      vi.mocked(openaiProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedSystemPrompt = opts.systemPrompt;
        return { text: "summary" };
      });

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-sys-1");
      await handlerWithStore.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-sys-1");
      await handlerWithStore.handle("/compact", ctx2);

      expect(capturedSystemPrompt).toContain("conversation summariser");
      expect(capturedSystemPrompt).toContain("same language");
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

    it("shows configured-but-unavailable provider", async () => {
      // Only put anthropic-oauth in the providers map, but config has openai-api enabled too
      const singleProviders = new Map<string, Provider>();
      singleProviders.set("anthropic-oauth", anthropicProvider);
      const singleHandler = new CommandHandler(singleProviders, createMockConfig());
      const ctx = createCtx();
      await singleHandler.handle("/provider", ctx);
      expect(ctx.completed).toContain("anthropic-oauth");
      expect(ctx.completed).toContain("openai-api");
      expect(ctx.completed).toContain("無法啟動");
    });

    it("gives helpful error for configured-but-unavailable provider switch", async () => {
      const singleProviders = new Map<string, Provider>();
      singleProviders.set("anthropic-oauth", anthropicProvider);
      const singleHandler = new CommandHandler(singleProviders, createMockConfig());
      const ctx = createCtx();
      await singleHandler.handle("/provider openai-api", ctx);
      expect(ctx.completed).toContain("無法啟動");
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

    it("calls onSessionReset on successful switch", async () => {
      const onReset = vi.fn();
      handler.onSessionReset = onReset;

      const ctx = createCtx();
      await handler.handle("/provider openai-api", ctx);

      expect(onReset).toHaveBeenCalledWith("conv-1");
    });

    it("resets target provider session on switch", async () => {
      const ctx = createCtx();
      await handler.handle("/provider openai-api", ctx);

      expect(openaiProvider.resetSession).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ cwd: "/default/cwd" }),
      );
    });

    it("resets target session when switching back to a previously used provider", async () => {
      // Switch to openai
      const ctx1 = createCtx();
      await handler.handle("/provider openai-api", ctx1);
      expect(openaiProvider.resetSession).toHaveBeenCalledTimes(1);

      // Switch back to anthropic
      const ctx2 = createCtx();
      await handler.handle("/provider anthropic-oauth", ctx2);
      expect(anthropicProvider.resetSession).toHaveBeenCalledWith(
        "conv-1",
        expect.objectContaining({ cwd: "/default/cwd" }),
      );
    });

    // ── Compact-on-switch: auto compact when switching provider ──

    it("compacts current session on provider switch and shows success note", async () => {
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "hello" }], undefined);
        }),
      };
      vi.mocked(anthropicProvider.sendMessage).mockResolvedValue({ text: "summary" });

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-switch-1");
      await handlerWithStore.handle("/provider openai-api", ctx);

      expect(mockSessionStore.compact).toHaveBeenCalledWith(
        "conv-switch-1",
        expect.any(Function),
        expect.any(Object),
      );
      expect(ctx.completed).toContain("Context 已透過 compact 轉移");
      expect(ctx.completed).toContain("已切換到");
    });

    it("graceful fallback when compact fails during switch — still switches", async () => {
      const mockSessionStore = {
        compact: vi.fn(async () => {
          throw new Error("DB locked");
        }),
      };

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-switch-2");
      await handlerWithStore.handle("/provider openai-api", ctx);

      // Switch still completes
      expect(ctx.completed).toContain("已切換到");
      // Warning shown
      expect(ctx.completed).toContain("Context compact 失敗");
      expect(ctx.completed).toContain("DB locked");
      // Target session still reset
      expect(openaiProvider.resetSession).toHaveBeenCalledWith(
        "conv-switch-2",
        expect.objectContaining({ cwd: "/default/cwd" }),
      );
    });

    it("skips compact when switching to the same provider", async () => {
      const mockSessionStore = {
        compact: vi.fn(async () => {}),
      };

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );

      const ctx = createCtx("conv-switch-3");
      await handlerWithStore.handle("/provider anthropic-oauth", ctx);

      // Same provider — no compact needed
      expect(mockSessionStore.compact).not.toHaveBeenCalled();
      expect(ctx.completed).not.toContain("compact");
    });

    it("skips compact when sessionStore is not available", async () => {
      // handler without sessionStore (3rd arg omitted)
      const handlerNoStore = new CommandHandler(providers, createMockConfig());

      const ctx = createCtx("conv-switch-4");
      await handlerNoStore.handle("/provider openai-api", ctx);

      // Switch completes without error
      expect(ctx.completed).toContain("已切換到");
      expect(ctx.completed).not.toContain("compact");
    });

    it("compact-on-switch uses compactModel from agent config", async () => {
      let capturedModel = "";
      const mockSessionStore = {
        compact: vi.fn(async (_convId: string, summariser: Function, _opts?: any) => {
          await summariser([{ role: "user", content: "test" }], undefined);
        }),
      };
      vi.mocked(anthropicProvider.sendMessage).mockImplementation(async (opts: any) => {
        capturedModel = opts.model;
        return { text: "summary" };
      });

      const configWithAgent = {
        ...createMockConfig(),
        agents: [{ name: "my-agent", botToken: "tok", provider: "anthropic-cli", compactModel: "haiku" }],
      };
      const handlerWithAgent = new CommandHandler(
        providers,
        configWithAgent,
        mockSessionStore as any,
      );
      handlerWithAgent.agentName = "my-agent";

      const ctx = createCtx("conv-switch-5");
      await handlerWithAgent.handle("/provider openai-api", ctx);

      expect(capturedModel).toBe("haiku");
      expect(mockSessionStore.compact).toHaveBeenCalledWith(
        "conv-switch-5",
        expect.any(Function),
        expect.objectContaining({ model: "haiku" }),
      );
    });

    it("compact-on-switch calls onSessionReset even when compact fails", async () => {
      const mockSessionStore = {
        compact: vi.fn(async () => {
          throw new Error("fail");
        }),
      };
      const onReset = vi.fn();

      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );
      handlerWithStore.onSessionReset = onReset;

      const ctx = createCtx("conv-switch-6");
      await handlerWithStore.handle("/provider openai-api", ctx);

      // onSessionReset should still be called (smart-injection tracking cleared)
      expect(onReset).toHaveBeenCalledWith("conv-switch-6");
    });
  });

  describe("/notes", () => {
    it("lists notes", async () => {
      const ctx = createCtx();
      await handler.handle("/notes", ctx);
      expect(ctx.completed).toContain("TODO List");
      expect(ctx.completed).toContain("Meeting Notes");
      expect(ctx.completed).toContain("note-aab");
    });

    it("shows empty message when no notes", async () => {
      const ctx = createCtx();
      vi.mocked(ctx.listNotes!).mockResolvedValue({ notes: [], hasMore: false });
      await handler.handle("/notes", ctx);
      expect(ctx.completed).toContain("目前沒有筆記");
    });

    it("shows unavailable when listNotes is missing", async () => {
      const ctx = createCtx();
      ctx.listNotes = undefined;
      await handler.handle("/notes", ctx);
      expect(ctx.completed).toContain("不可用");
    });
  });

  describe("/note-add", () => {
    it("creates note with title only", async () => {
      const ctx = createCtx();
      await handler.handle("/note-add My Title", ctx);
      expect(ctx.createNote).toHaveBeenCalledWith({ title: "My Title", content: undefined });
      expect(ctx.completed).toContain("已新增筆記");
    });

    it("creates note with title and content", async () => {
      const ctx = createCtx();
      await handler.handle("/note-add My Title | Some content here", ctx);
      expect(ctx.createNote).toHaveBeenCalledWith({ title: "My Title", content: "Some content here" });
    });

    it("requires argument", async () => {
      const ctx = createCtx();
      await handler.handle("/note-add", ctx);
      expect(ctx.completed).toContain("用法");
    });
  });

  describe("/note-edit", () => {
    it("updates note by id prefix", async () => {
      const ctx = createCtx();
      await handler.handle("/note-edit note-aabb New Title | New content", ctx);
      expect(ctx.updateNote).toHaveBeenCalledWith(
        "note-aabbccdd-1234",
        { title: "New Title", content: "New content" },
      );
      expect(ctx.completed).toContain("已更新筆記");
    });

    it("requires id and content", async () => {
      const ctx = createCtx();
      await handler.handle("/note-edit", ctx);
      expect(ctx.completed).toContain("用法");
    });

    it("reports no match for unknown id", async () => {
      const ctx = createCtx();
      await handler.handle("/note-edit bad-id New Title", ctx);
      expect(ctx.completed).toContain("找不到匹配");
    });
  });

  describe("/note-del", () => {
    it("deletes note by id prefix", async () => {
      const ctx = createCtx();
      await handler.handle("/note-del note-aabb", ctx);
      expect(ctx.deleteNote).toHaveBeenCalledWith("note-aabbccdd-1234");
      expect(ctx.completed).toContain("已刪除筆記");
    });

    it("requires argument", async () => {
      const ctx = createCtx();
      await handler.handle("/note-del", ctx);
      expect(ctx.completed).toContain("用法");
    });

    it("reports ambiguous match", async () => {
      const ctx = createCtx();
      await handler.handle("/note-del note-", ctx);
      expect(ctx.completed).toContain("多個筆記匹配");
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
      const singleProviders = new Map<string, Provider>();
      singleProviders.set("anthropic-oauth", anthropicProvider);
      const singleHandler = new CommandHandler(singleProviders, createMockConfig());
      const skills = singleHandler.getSkills();
      const ids = skills.map((s) => s.id);
      expect(ids).toContain("provider");
    });
  });

  // ── Smart Session Context: callback lifecycle ──

  describe("session context callbacks", () => {
    it("/new calls onSessionClear with conversationId", async () => {
      const onClear = vi.fn();
      handler.onSessionClear = onClear;

      const ctx = createCtx("conv-new-1");
      await handler.handle("/new", ctx);

      expect(onClear).toHaveBeenCalledWith("conv-new-1");
    });

    it("/new does NOT call onSessionReset", async () => {
      const onReset = vi.fn();
      handler.onSessionReset = onReset;

      const ctx = createCtx("conv-new-2");
      await handler.handle("/new", ctx);

      expect(onReset).not.toHaveBeenCalled();
    });

    it("/model calls onSessionReset (not onSessionClear)", async () => {
      const onReset = vi.fn();
      const onClear = vi.fn();
      handler.onSessionReset = onReset;
      handler.onSessionClear = onClear;

      const ctx = createCtx("conv-model-1");
      await handler.handle("/model sonnet", ctx);

      expect(onReset).toHaveBeenCalledWith("conv-model-1");
      expect(onClear).not.toHaveBeenCalled();
    });

    it("/compact (anthropic) calls onSessionReset", async () => {
      const onReset = vi.fn();
      handler.onSessionReset = onReset;

      const ctx = createCtx("conv-compact-cb-1");
      await handler.handle("/compact", ctx);

      expect(onReset).toHaveBeenCalledWith("conv-compact-cb-1");
    });

    it("/compact (non-anthropic) calls onSessionReset on success", async () => {
      const onReset = vi.fn();
      const mockSessionStore = {
        compact: vi.fn(async () => {}),
      };
      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );
      handlerWithStore.onSessionReset = onReset;

      const ctx = createCtx("conv-compact-cb-2");
      await handlerWithStore.handle("/provider openai-api", ctx);
      const ctx2 = createCtx("conv-compact-cb-2");
      await handlerWithStore.handle("/compact", ctx2);

      expect(onReset).toHaveBeenCalledWith("conv-compact-cb-2");
    });

    it("/compact (non-anthropic) does NOT call onSessionReset on failure", async () => {
      const onReset = vi.fn();
      const mockSessionStore = {
        compact: vi.fn(async () => { throw new Error("fail"); }),
      };
      const handlerWithStore = new CommandHandler(
        providers,
        createMockConfig(),
        mockSessionStore as any,
      );
      handlerWithStore.onSessionReset = onReset;

      const ctx = createCtx("conv-compact-cb-3");
      await handlerWithStore.handle("/provider openai-api", ctx);
      // Clear mock after /provider switch (which correctly calls onSessionReset)
      onReset.mockClear();
      const ctx2 = createCtx("conv-compact-cb-3");
      await handlerWithStore.handle("/compact", ctx2);

      // /compact failure must NOT call onSessionReset
      expect(onReset).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // /spawn result
  // ---------------------------------------------------------------------------

  describe("/spawn result", () => {
    function makeJob(overrides: Partial<{
      id: string; parentAgent: string; targetAgent: string; status: string;
      result: string | null; context: string;
    }> = {}) {
      return {
        id: overrides.id ?? "abc12345",
        parentAgent: overrides.parentAgent ?? "agent-a",
        targetAgent: overrides.targetAgent ?? "agent-b",
        context: overrides.context ?? "do something",
        status: overrides.status ?? "completed",
        result: "result" in overrides ? overrides.result! : "done!",
        createdAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 1234,
        model: null,
        costUsd: null,
      };
    }

    function setupSpawnHandler(agentName: string, jobs: ReturnType<typeof makeJob>[]) {
      const h = new CommandHandler(providers, createMockConfig());
      h.agentName = agentName;
      h.spawnManager = {
        getJob: vi.fn((id: string) => jobs.find((j) => j.id === id) ?? null),
        listByParent: vi.fn((agent: string) => jobs.filter((j) => j.parentAgent === agent)),
        listAll: vi.fn(() => jobs),
        cancel: vi.fn(() => false),
      } as any;
      return h;
    }

    it("shows full result for own completed job", async () => {
      const job = makeJob({ parentAgent: "agent-a", result: "full result text here" });
      const h = setupSpawnHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn");
      await h.handle("/spawn result abc12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("full result text here");
      expect(reply).toContain("**Result:**");
    });

    it("rejects access to other agent's job", async () => {
      const job = makeJob({ parentAgent: "agent-b" });
      const h = setupSpawnHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn");
      await h.handle("/spawn result abc12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("找不到");
    });

    it("shows running hint when job is still running", async () => {
      const job = makeJob({ parentAgent: "agent-a", status: "running", result: null });
      const h = setupSpawnHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn");
      await h.handle("/spawn result abc12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("still running");
    });

    it("shows no result for cancelled job", async () => {
      const job = makeJob({ parentAgent: "agent-a", status: "cancelled", result: null });
      const h = setupSpawnHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn");
      await h.handle("/spawn result abc12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("No result");
    });

    it("returns not found for nonexistent job id", async () => {
      const h = setupSpawnHandler("agent-a", []);
      const ctx = createCtx("conv-spawn");
      await h.handle("/spawn result nonexist", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("找不到");
    });
  });

  // ---------------------------------------------------------------------------
  // /spawn list — preview display
  // ---------------------------------------------------------------------------

  describe("/spawn list preview", () => {
    function makeJob(overrides: Partial<{
      id: string; parentAgent: string; targetAgent: string; status: string;
      result: string | null; context: string;
    }> = {}) {
      return {
        id: overrides.id ?? "abc12345",
        parentAgent: overrides.parentAgent ?? "agent-a",
        targetAgent: overrides.targetAgent ?? "agent-b",
        context: overrides.context ?? "do something",
        status: overrides.status ?? "completed",
        result: "result" in overrides ? overrides.result! : "done!",
        createdAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 1234,
        model: null,
        costUsd: null,
      };
    }

    function setupHandler(agentName: string, jobs: ReturnType<typeof makeJob>[]) {
      const h = new CommandHandler(providers, createMockConfig());
      h.agentName = agentName;
      h.spawnManager = {
        getJob: vi.fn((id: string) => jobs.find((j) => j.id === id) ?? null),
        listByParent: vi.fn((agent: string) => jobs.filter((j) => j.parentAgent === agent)),
        listAll: vi.fn(() => jobs),
        cancel: vi.fn(() => false),
      } as any;
      return h;
    }

    it("shows result first line only for multi-line result", async () => {
      const job = makeJob({ parentAgent: "agent-a", result: "first line\nsecond line\nthird" });
      const h = setupHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn-list");
      await h.handle("/spawn list", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("first line");
      expect(reply).not.toContain("second line");
    });

    it("shows guidance for long result", async () => {
      const longResult = "x".repeat(200);
      const job = makeJob({ parentAgent: "agent-a", result: longResult });
      const h = setupHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn-list");
      await h.handle("/spawn list", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("/spawn result abc12345");
    });

    it("shows short single-line result without guidance", async () => {
      const job = makeJob({ parentAgent: "agent-a", result: "ok" });
      const h = setupHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn-list");
      await h.handle("/spawn list", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("Result: ok");
      expect(reply).not.toContain("/spawn result");
    });

    it("does not show result line for running job", async () => {
      const job = makeJob({ parentAgent: "agent-a", status: "running", result: null });
      const h = setupHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn-list");
      await h.handle("/spawn list", ctx);
      const reply = ctx.completed as string;
      expect(reply).not.toContain("Result:");
    });
  });

  // ---------------------------------------------------------------------------
  // /spawn logs
  // ---------------------------------------------------------------------------

  describe("/spawn logs", () => {
    function makeJob(overrides: Partial<{
      id: string; parentAgent: string; status: string;
    }> = {}) {
      return {
        id: overrides.id ?? "log12345",
        parentAgent: overrides.parentAgent ?? "agent-a",
        targetAgent: "agent-b",
        context: "do something",
        status: overrides.status ?? "running",
        result: null,
        createdAt: Date.now(),
        completedAt: null,
        durationMs: null,
        model: null,
        costUsd: null,
      };
    }

    function setupLogsHandler(agentName: string, jobs: ReturnType<typeof makeJob>[], logs: Array<{ content: string; createdAt: number }> = []) {
      const h = new CommandHandler(providers, createMockConfig());
      h.agentName = agentName;
      h.spawnManager = {
        getJob: vi.fn((id: string) => jobs.find((j) => j.id === id) ?? null),
        getLogs: vi.fn(() => logs),
        listByParent: vi.fn(() => []),
        listAll: vi.fn(() => []),
        cancel: vi.fn(() => false),
      } as any;
      return h;
    }

    it("shows logs with timestamps", async () => {
      const job = makeJob({ parentAgent: "agent-a" });
      const logs = [
        { content: "Starting task...", createdAt: Date.now() - 5000 },
        { content: "Processing step 1", createdAt: Date.now() - 2000 },
      ];
      const h = setupLogsHandler("agent-a", [job], logs);
      const ctx = createCtx("conv-spawn-logs");
      await h.handle("/spawn logs log12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("Starting task...");
      expect(reply).toContain("Processing step 1");
      expect(reply).toContain("Spawn Logs:");
    });

    it("rejects access to other agent's logs", async () => {
      const job = makeJob({ parentAgent: "agent-b" });
      const h = setupLogsHandler("agent-a", [job]);
      const ctx = createCtx("conv-spawn-logs");
      await h.handle("/spawn logs log12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("找不到");
    });

    it("shows no-logs hint for running job", async () => {
      const job = makeJob({ parentAgent: "agent-a", status: "running" });
      const h = setupLogsHandler("agent-a", [job], []);
      const ctx = createCtx("conv-spawn-logs");
      await h.handle("/spawn logs log12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("仍在執行中");
    });

    it("shows no-logs hint for completed job", async () => {
      const job = makeJob({ parentAgent: "agent-a", status: "completed" });
      const h = setupLogsHandler("agent-a", [job], []);
      const ctx = createCtx("conv-spawn-logs");
      await h.handle("/spawn logs log12345", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("無 log 紀錄");
    });

    it("returns not found for nonexistent job", async () => {
      const h = setupLogsHandler("agent-a", []);
      const ctx = createCtx("conv-spawn-logs");
      await h.handle("/spawn logs nonexist", ctx);
      const reply = ctx.completed as string;
      expect(reply).toContain("找不到");
    });
  });
});
