import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AnthropicSdkProvider } from "../../../src/providers/anthropic-sdk.js";

// Mock the @anthropic-ai/claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(({ prompt }: { prompt: string }) => {
      // Return an async generator that yields SDKMessages
      async function* stream() {
        // Yield a stream_event with text delta
        yield {
          uuid: "uuid-1",
          session_id: "sdk-session-123",
          type: "stream_event" as const,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: `Response to: ${prompt}` },
          },
          parent_tool_use_id: null,
        };
        // Yield a result message
        yield {
          uuid: "uuid-2",
          session_id: "sdk-session-123",
          type: "result" as const,
          subtype: "success",
          duration_ms: 1000,
          duration_api_ms: 800,
          is_error: false,
          num_turns: 1,
          result: `Response to: ${prompt}`,
          total_cost_usd: 0.05,
          usage: { input_tokens: 10, output_tokens: 20 },
          modelUsage: {},
          permission_denials: [],
        };
      }
      return stream();
    }),
  };
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("AnthropicSdkProvider", () => {
  let provider: AnthropicSdkProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicSdkProvider(
      {
        providerId: "anthropic-api",
        displayName: "Anthropic API",
        apiKey: "sk-ant-test-key",
        defaultModel: "sonnet",
        defaultCwd: "/default",
        maxSessions: 5,
        idleTimeoutMs: 600_000,
      },
      logger,
    );
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("has correct id and displayName", () => {
    expect(provider.id).toBe("anthropic-api");
    expect(provider.displayName).toContain("Anthropic API");
  });

  describe("sendMessage", () => {
    it("sends message via SDK and streams response", async () => {
      const chunks: string[] = [];
      const result = await provider.sendMessage({
        conversationId: "conv-1",
        content: "Hello SDK",
        onChunk: (text) => chunks.push(text),
      });

      expect(result.text).toBe("Response to: Hello SDK");
      expect(chunks).toContain("Response to: Hello SDK");
      expect(result.sessionId).toBe("sdk-session-123");
    });

    it("tracks cost from result messages", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const cost = provider.getCostInfo("conv-1");
      expect(cost).not.toBeNull();
      expect(cost!.totalCostUsd).toBe(0.05);
    });

    it("accumulates cost across messages", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "msg1",
        onChunk: () => {},
      });

      await provider.sendMessage({
        conversationId: "conv-1",
        content: "msg2",
        onChunk: () => {},
      });

      const cost = provider.getCostInfo("conv-1");
      expect(cost!.totalCostUsd).toBe(0.1); // 0.05 + 0.05
    });
  });

  describe("interrupt", () => {
    it("does not throw for non-existent session", () => {
      expect(() => provider.interrupt("conv-999")).not.toThrow();
    });
  });

  describe("resetSession", () => {
    it("clears session", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      await provider.resetSession("conv-1");
      expect(provider.getSessionInfo("conv-1")).toBeNull();
    });
  });

  describe("resumeSession", () => {
    it("creates new session with given session ID", async () => {
      const ok = await provider.resumeSession("conv-1", "old-session-id");
      expect(ok).toBe(true);

      const info = provider.getSessionInfo("conv-1");
      expect(info).not.toBeNull();
      expect(info!.sessionId).toBe("old-session-id");
    });
  });

  describe("listSessions", () => {
    it("lists tracked sessions", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      const sessions = provider.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].providerId).toBe("anthropic-api");
    });
  });

  describe("supportedModels", () => {
    it("returns null when no models configured", () => {
      const models = provider.supportedModels();
      expect(models).toBeNull();
    });

    it("returns custom models when configured", () => {
      const customProvider = new AnthropicSdkProvider(
        {
          providerId: "custom-sdk",
          displayName: "Custom SDK",
          apiKey: "sk-ant-test",
          defaultCwd: "/default",
          maxSessions: 5,
          idleTimeoutMs: 600_000,
          models: ["opus", "sonnet", "haiku"],
        },
        logger,
      );
      expect(customProvider.supportedModels()).toEqual(["opus", "sonnet", "haiku"]);
    });
  });

  describe("shutdown", () => {
    it("clears all sessions", async () => {
      await provider.sendMessage({
        conversationId: "conv-1",
        content: "test",
        onChunk: () => {},
      });

      await provider.shutdown();
      expect(provider.listSessions()).toHaveLength(0);
    });
  });

  describe("setAgentMcpConfig", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = path.join(tmpdir(), `sdk-mcp-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("loads per-agent MCP servers from JSON file", () => {
      const configPath = path.join(tmpDir, "gina.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          arinova: {
            command: "node",
            args: ["/path/to/cli.js"],
            env: { ARINOVA_BOT_TOKEN: "ari_gina_token" },
          },
        },
      }));

      provider.setAgentMcpConfig!("gina", configPath);

      // Verify per-agent servers are stored by sending a message
      // The mock SDK captures the options; if it doesn't throw, the
      // provider resolved servers without error
      expect(() => provider.setAgentMcpConfig!("gina", configPath)).not.toThrow();
    });

    it("logs error for missing config file", () => {
      provider.setAgentMcpConfig!("missing", "/nonexistent/path.json");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("failed to load per-agent MCP config"),
      );
    });

    it("uses per-agent servers over provider-level default", async () => {
      const providerWithMcp = new AnthropicSdkProvider(
        {
          providerId: "sdk-mcp",
          displayName: "SDK MCP",
          apiKey: "sk-ant-test",
          defaultCwd: "/default",
          maxSessions: 5,
          idleTimeoutMs: 600_000,
          mcpServers: {
            arinova: {
              type: "stdio",
              command: "node",
              args: ["/cli.js"],
              env: { ARINOVA_BOT_TOKEN: "ari_global" },
            },
          },
        },
        logger,
      );

      const configPath = path.join(tmpDir, "vera.json");
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          arinova: {
            command: "node",
            args: ["/cli.js"],
            env: { ARINOVA_BOT_TOKEN: "ari_vera_token" },
          },
        },
      }));
      providerWithMcp.setAgentMcpConfig!("vera", configPath);

      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const mockQuery = vi.mocked(query);
      mockQuery.mockClear();

      await providerWithMcp.sendMessage({
        conversationId: "vera:default",
        content: "test",
        onChunk: () => {},
      });

      const callOpts = mockQuery.mock.calls[0][0].options as Record<string, unknown>;
      const servers = callOpts.mcpServers as Record<string, { env?: Record<string, string> }>;
      expect(servers.arinova.env!.ARINOVA_BOT_TOKEN).toBe("ari_vera_token");

      await providerWithMcp.shutdown();
    });
  });
});
