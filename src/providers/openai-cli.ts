import type {
  Provider,
  ProviderId,
  SendMessageOpts,
  SendResult,
  SessionOpts,
  SessionInfo,
  CostInfo,
  UsageInfo,
  SessionListEntry,
} from "./types.js";
import { initDb, type BridgeDb } from "../codex/db.js";
import { CodexAppServer } from "../codex/app-server.js";
import { buildContextPrefix } from "../util/context.js";
import { ensureAgentCodexHome, type McpStdioServer } from "../mcp/preinstalled.js";
import type { Logger } from "../util/logger.js";
import { homedir } from "node:os";
import path from "node:path";

export interface OpenAICliConfig {
  providerId: string;
  displayName: string;
  codexPath?: string;
  apiKey?: string;
  defaultCwd: string;
  dbPath: string;
  env?: Record<string, string>;
  models?: string[];
  userMcp?: Record<string, McpStdioServer>;
  configDir?: string;
}

/**
 * OpenAI CLI provider: uses `codex app-server` JSON-RPC protocol.
 * Provides full rate limit, token usage, and context window tracking.
 */
export class OpenAICliProvider implements Provider {
  readonly id: string;
  readonly type = "openai-cli";
  readonly displayName: string;

  private defaultCwd: string;
  private db: BridgeDb;
  private defaultServer: CodexAppServer;
  private agentServers = new Map<string, CodexAppServer>();
  private conversationServers = new Map<string, CodexAppServer>();
  private logger: Logger;
  private codexPath?: string;
  private resolvedCodexPath: string;
  private modelList: string[];
  private providerEnv: Record<string, string>;
  private agentMcpEnv = new Map<string, Record<string, string>>();
  private agentCodexHomes = new Map<string, string>();
  private userMcp?: Record<string, McpStdioServer>;
  private configDir?: string;

  constructor(config: OpenAICliConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.defaultCwd = config.defaultCwd;
    this.logger = logger;
    this.codexPath = config.codexPath;
    this.resolvedCodexPath = config.codexPath ?? "codex";
    this.userMcp = config.userMcp;
    this.configDir = config.configDir;
    this.modelList = config.models ?? [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
    ];
    this.providerEnv = config.env ?? {};

    this.db = initDb(config.dbPath);

    this.defaultServer = new CodexAppServer({
      codexPath: config.codexPath,
      env: this.providerEnv,
      logger,
    });

    // Load cached rate limits
    const cached = this.db.loadRateLimitCache();
    if (cached) {
      try {
        const snapshot = JSON.parse(cached);
        // Inject into server (exposed for pre-warming /usage before first turn)
        (this.defaultServer as unknown as { rateLimitSnapshot: unknown }).rateLimitSnapshot = snapshot;
        logger.info("openai-cli: loaded cached rate limits from DB");
      } catch { /* ignore */ }
    }
  }

  warmup(): void { /* no-op for openai-cli */ }

  setAgentMcpEnv(agentName: string, env: Record<string, string>): void {
    this.agentMcpEnv.set(agentName, env);
    const botToken = env.ARINOVA_BOT_TOKEN;
    const serverUrl = env.ARINOVA_SERVER_URL;
    if (!botToken || !serverUrl) return;

    const safeProviderId = this.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const safeAgentName = agentName.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const codexHome = path.join(homedir(), ".arinova-bridge", "codex", safeProviderId, safeAgentName);
    ensureAgentCodexHome(
      this.resolvedCodexPath,
      this.logger,
      codexHome,
      { botToken, serverUrl },
      this.userMcp,
      this.configDir,
    );
    this.agentCodexHomes.set(agentName, codexHome);
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal } = opts;
    const systemPromptPrefix = opts.systemPrompt ? `<system-prompt>\n${opts.systemPrompt}\n</system-prompt>\n\n` : "";
    const content = systemPromptPrefix + buildContextPrefix(opts) + opts.content;
    const effectiveCwd = cwd ?? this.getConvCwd(conversationId) ?? this.defaultCwd;
    const effectiveModel = model ?? this.getConvModel(conversationId) ?? undefined;
    // Per-thread agent name — CodexAppServer is a long-running process, so
    // set the agent name via thread config rather than process env.
    const agentName = conversationId.split(":")[0] || undefined;
    const agentEnv = agentName ? this.agentMcpEnv.get(agentName) : undefined;
    const server = this.resolveServer(agentName);
    this.conversationServers.set(conversationId, server);

    // Wire abort signal
    const onAbort = () => this.interrupt(conversationId);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      this.db.upsertConversation(conversationId, { status: "busy" });

      const result = await server.sendMessage(
        conversationId,
        content,
        onChunk,
        { cwd: effectiveCwd, model: effectiveModel, agentName, env: agentEnv },
      );

      // Persist thread ID
      if (result.threadId) {
        this.db.upsertConversation(conversationId, {
          threadId: result.threadId,
          status: "ready",
        });
      }

      // Update token usage from server tracking
      const usage = server.getTokenUsage(conversationId);
      if (usage) {
        // Reset and set absolute values (server tracks totals)
        this.db.resetConversation(conversationId, effectiveCwd);
        this.db.upsertConversation(conversationId, {
          threadId: result.threadId,
          status: "ready",
          model: effectiveModel,
        });
        this.db.addTokenUsage(conversationId, {
          inputTokens: usage.total.inputTokens,
          cachedInputTokens: usage.total.cachedInputTokens,
          outputTokens: usage.total.outputTokens,
        });
      } else {
        this.db.updateStatus(conversationId, "ready");
      }

      // Cache rate limits
      const rl = server.getRateLimits();
      if (rl) {
        this.db.saveRateLimitCache(JSON.stringify(rl));
      }

      return {
        text: result.text,
        sessionId: result.threadId,
      };
    } catch (err) {
      this.db.updateStatus(conversationId, "error");
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  interrupt(conversationId: string): void {
    this.resolveConversationServer(conversationId).interrupt(conversationId);
  }

  async resetSession(conversationId: string, opts?: SessionOpts): Promise<void> {
    const server = this.resolveConversationServer(conversationId);
    server.clearThread(conversationId);
    if (opts?.restartProcess) {
      await server.shutdown();
    }
    this.conversationServers.delete(conversationId);
    const conv = this.db.getConversation(conversationId);
    if (conv) {
      this.db.resetConversation(conversationId, opts?.cwd ?? null);
    } else {
      this.db.upsertConversation(conversationId, {
        status: "ready",
        cwd: opts?.cwd,
      });
    }
    if (opts?.model) {
      this.db.upsertConversation(conversationId, { model: opts.model });
    }
  }

  async resumeSession(
    conversationId: string,
    sessionId: string,
    _opts?: SessionOpts,
  ): Promise<boolean> {
    this.db.upsertConversation(conversationId, {
      threadId: sessionId,
      status: "ready",
    });
    return true;
  }

  getSessionInfo(conversationId: string): SessionInfo | null {
    const conv = this.db.getConversation(conversationId);
    const server = this.resolveConversationServer(conversationId);
    const threadId = server.getThreadId(conversationId) ?? conv?.threadId;
    if (!threadId) return null;

    return {
      sessionId: threadId,
      alive: server.isReady(),
      cwd: conv?.cwd ?? this.defaultCwd,
      model: conv?.model ?? undefined,
    };
  }

  getCostInfo(conversationId: string): CostInfo | null {
    const conv = this.db.getConversation(conversationId);
    if (!conv) return null;

    return {
      inputTokens: conv.inputTokens,
      cachedInputTokens: conv.cachedInputTokens,
      outputTokens: conv.outputTokens,
    };
  }

  getUsageInfo(conversationId: string): UsageInfo | null {
    const result: UsageInfo = {};

    // Context from server tracking
    const server = this.resolveConversationServer(conversationId);
    const ctx = server.getContextUsage(conversationId);
    if (ctx) {
      result.context = {
        contextTokens: ctx.contextTokens,
        contextWindow: ctx.contextWindow,
      };
    }

    // Rate limits from server snapshot
    const rl = server.getRateLimits();
    if (rl) {
      result.rateLimits = [];
      if (rl.primary) {
        result.rateLimits.push({
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: rl.primary.usedPercent / 100,
          resetsAt: rl.primary.resetsAt ?? undefined,
        });
      }
      if (rl.secondary) {
        result.rateLimits.push({
          status: "allowed",
          rateLimitType: "seven_day",
          utilization: rl.secondary.usedPercent / 100,
          resetsAt: rl.secondary.resetsAt ?? undefined,
        });
      }
    }

    // Token window from server
    const usage = server.getTokenUsage(conversationId);
    if (usage) {
      result.window = {
        inputTokens: usage.total.inputTokens + usage.total.cachedInputTokens,
        outputTokens: usage.total.outputTokens,
        costUsd: 0,
        turns: 0,
        resetsAt: 0,
      };
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  listSessions(): SessionListEntry[] {
    const all = this.db.getAllConversations();
    return all.map((conv) => {
      const server = this.resolveConversationServer(conv.convId);
      return {
        providerId: this.id,
        sessionId: conv.threadId ?? "",
        conversationId: conv.convId,
        alive: server.isReady() && !!server.getThreadId(conv.convId),
        status: (conv.status === "error" ? "error" : conv.status === "busy" ? "busy" : "ready") as "ready" | "busy" | "error",
        cwd: conv.cwd ?? this.defaultCwd,
        model: conv.model ?? undefined,
      };
    });
  }

  supportedModels(): string[] {
    return this.modelList;
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.defaultServer.shutdown(),
      ...Array.from(this.agentServers.values()).map((server) => server.shutdown()),
    ]);
  }

  setEnv(key: string, value: string): void {
    this.providerEnv[key] = value;
  }

  private getConvCwd(conversationId: string): string | null {
    return this.db.getConversation(conversationId)?.cwd ?? null;
  }

  private getConvModel(conversationId: string): string | null {
    return this.db.getConversation(conversationId)?.model ?? null;
  }

  private resolveServer(agentName: string | undefined): CodexAppServer {
    if (!agentName) return this.defaultServer;
    const agentEnv = this.agentMcpEnv.get(agentName);
    if (!agentEnv) return this.defaultServer;

    const existing = this.agentServers.get(agentName);
    if (existing) return existing;

    const codexHome = this.agentCodexHomes.get(agentName);
    const server = new CodexAppServer({
      codexPath: this.codexPath,
      env: { ...this.providerEnv, ...(codexHome ? { CODEX_HOME: codexHome } : {}), ...agentEnv },
      logger: this.logger,
    });
    this.agentServers.set(agentName, server);
    return server;
  }

  private resolveConversationServer(conversationId: string): CodexAppServer {
    const existing = this.conversationServers.get(conversationId);
    if (existing) return existing;
    const agentName = conversationId.split(":")[0] || undefined;
    return this.resolveServer(agentName);
  }
}
