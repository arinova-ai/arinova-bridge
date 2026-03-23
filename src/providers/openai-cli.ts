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
import type { Logger } from "../util/logger.js";

export interface OpenAICliConfig {
  providerId: string;
  displayName: string;
  codexPath?: string;
  apiKey?: string;
  defaultCwd: string;
  dbPath: string;
  env?: Record<string, string>;
  models?: string[];
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
  private server: CodexAppServer;
  private logger: Logger;
  private modelList: string[];

  constructor(config: OpenAICliConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.defaultCwd = config.defaultCwd;
    this.logger = logger;
    this.modelList = config.models ?? [
      "codex-mini-latest",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "o4-mini",
      "o3",
    ];

    this.db = initDb(config.dbPath);

    this.server = new CodexAppServer({
      codexPath: config.codexPath,
      env: config.env,
      logger,
    });

    // Load cached rate limits
    const cached = this.db.loadRateLimitCache();
    if (cached) {
      try {
        const snapshot = JSON.parse(cached);
        // Inject into server (exposed for pre-warming /usage before first turn)
        (this.server as unknown as { rateLimitSnapshot: unknown }).rateLimitSnapshot = snapshot;
        logger.info("openai-cli: loaded cached rate limits from DB");
      } catch { /* ignore */ }
    }
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal } = opts;
    const content = buildContextPrefix(opts) + opts.content;
    const effectiveCwd = cwd ?? this.getConvCwd(conversationId) ?? this.defaultCwd;
    const effectiveModel = model ?? this.getConvModel(conversationId) ?? undefined;

    // Wire abort signal
    const onAbort = () => this.interrupt(conversationId);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      this.db.upsertConversation(conversationId, { status: "busy" });

      const result = await this.server.sendMessage(
        conversationId,
        content,
        onChunk,
        { cwd: effectiveCwd, model: effectiveModel },
      );

      // Persist thread ID
      if (result.threadId) {
        this.db.upsertConversation(conversationId, {
          threadId: result.threadId,
          status: "ready",
        });
      }

      // Update token usage from server tracking
      const usage = this.server.getTokenUsage(conversationId);
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
      const rl = this.server.getRateLimits();
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
    this.server.interrupt(conversationId);
  }

  async resetSession(conversationId: string, opts?: SessionOpts): Promise<void> {
    this.server.clearThread(conversationId);
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
    const threadId = this.server.getThreadId(conversationId) ?? conv?.threadId;
    if (!threadId) return null;

    return {
      sessionId: threadId,
      alive: this.server.isReady(),
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
    const ctx = this.server.getContextUsage(conversationId);
    if (ctx) {
      result.context = {
        contextTokens: ctx.contextTokens,
        contextWindow: ctx.contextWindow,
      };
    }

    // Rate limits from server snapshot
    const rl = this.server.getRateLimits();
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
    const usage = this.server.getTokenUsage(conversationId);
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
    return all.map((conv) => ({
      providerId: this.id,
      sessionId: conv.threadId ?? "",
      conversationId: conv.convId,
      alive: this.server.isReady() && !!this.server.getThreadId(conv.convId),
      status: (conv.status === "error" ? "error" : conv.status === "busy" ? "busy" : "ready") as "ready" | "busy" | "error",
      cwd: conv.cwd ?? this.defaultCwd,
      model: conv.model ?? undefined,
    }));
  }

  supportedModels(): string[] {
    return this.modelList;
  }

  async shutdown(): Promise<void> {
    await this.server.shutdown();
  }

  private getConvCwd(conversationId: string): string | null {
    return this.db.getConversation(conversationId)?.cwd ?? null;
  }

  private getConvModel(conversationId: string): string | null {
    return this.db.getConversation(conversationId)?.model ?? null;
  }
}
