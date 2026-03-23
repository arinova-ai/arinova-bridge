import type {
  Provider,
  SendMessageOpts,
  SendResult,
  SessionOpts,
  SessionInfo,
  CostInfo,
  UsageInfo,
  SessionListEntry,
} from "./types.js";
import { SessionStore } from "../claude/session-store.js";
import { buildContextPrefix } from "../util/context.js";
import type { Logger } from "../util/logger.js";

export interface AnthropicCliConfig {
  providerId: string;
  displayName: string;
  claudePath: string;
  mcpConfigPath?: string;
  defaultCwd: string;
  maxSessions: number;
  idleTimeoutMs: number;
  env?: Record<string, string>;
  models?: string[];
}

/**
 * anthropic-cli provider: spawns a persistent `claude` CLI process.
 * Works for Anthropic OAuth, Anthropic-compatible providers (MiniMax, etc.)
 */
export class AnthropicCliProvider implements Provider {
  readonly id: string;
  readonly type = "anthropic-cli";
  readonly displayName: string;

  private store: SessionStore;
  private defaultCwd: string;
  private models: string[] | null;

  constructor(config: AnthropicCliConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.defaultCwd = config.defaultCwd;
    this.models = config.models ?? null;
    this.store = new SessionStore(
      {
        claudePath: config.claudePath,
        mcpConfigPath: config.mcpConfigPath,
        defaultCwd: config.defaultCwd,
        maxSessions: config.maxSessions,
        idleTimeoutMs: config.idleTimeoutMs,
        env: config.env,
      },
      logger,
    );
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal } = opts;
    const content = buildContextPrefix(opts) + opts.content;

    let entry = this.store.getSession(conversationId);

    if (entry && entry.process.isAlive()) {
      // Abort any in-flight turn (e.g. cancel + immediate new message)
      if (entry.process.isBusy()) {
        entry.process.abortTurn();
      }
      entry.lastActivity = Date.now();
    } else {
      entry = this.store.createSession(conversationId, { cwd, model });
    }

    // Signal is managed inside ClaudeProcess — it clears the old listener
    // before attaching the new one, preventing stale signals from aborting
    // the wrong turn.
    const result = await entry.process.sendMessage(content, (text) => {
      onChunk(text);
    }, signal);

    return {
      text: result.text,
      sessionId: result.sessionId,
    };
  }

  interrupt(conversationId: string): void {
    const entry = this.store.getSession(conversationId);
    if (entry?.process.isBusy()) {
      entry.process.abortTurn();
    }
  }

  async resetSession(conversationId: string, opts?: SessionOpts): Promise<void> {
    await this.store.destroySession(conversationId);
    if (opts?.cwd || opts?.model) {
      this.store.createSession(conversationId, {
        cwd: opts.cwd,
        model: opts.model,
      });
    }
  }

  async resumeSession(
    conversationId: string,
    sessionId: string,
    opts?: SessionOpts,
  ): Promise<boolean> {
    const entry = await this.store.resumeSession(conversationId, sessionId);
    return entry !== null;
  }

  getSessionInfo(conversationId: string): SessionInfo | null {
    const entry = this.store.getSession(conversationId);
    if (!entry || !entry.process.isAlive()) return null;

    return {
      sessionId: entry.process.getSessionId(),
      alive: entry.process.isAlive(),
      cwd: entry.process.getCwd() ?? this.defaultCwd,
      model: entry.process.getModel(),
    };
  }

  getCostInfo(conversationId: string): CostInfo | null {
    const entry = this.store.getSession(conversationId);
    if (!entry) return null;

    return {
      totalCostUsd: entry.process.getTotalCost(),
    };
  }

  getUsageInfo(conversationId: string): UsageInfo | null {
    const entry = this.store.getSession(conversationId);
    if (!entry || !entry.process.isAlive()) return null;

    const result: UsageInfo = {};

    const ctx = entry.process.getContext();
    if (ctx) result.context = { ...ctx };

    const rlMap = entry.process.getRateLimits();
    if (rlMap.size > 0) {
      result.rateLimits = [];
      for (const rl of rlMap.values()) {
        result.rateLimits.push({
          status: rl.status,
          rateLimitType: rl.rateLimitType ?? "unknown",
          utilization: rl.utilization,
          resetsAt: rl.resetsAt,
          overageStatus: rl.overageStatus,
          isUsingOverage: rl.isUsingOverage,
        });
      }
    }

    const win = entry.process.getWindowUsage();
    if (win) result.window = { ...win };

    const cost = entry.process.getTotalCost();
    if (cost > 0) result.totalCostUsd = cost;

    return result;
  }

  listSessions(): SessionListEntry[] {
    return this.store.listSessions().map((s) => ({
      providerId: this.id,
      sessionId: s.sessionId,
      conversationId: s.conversationId,
      alive: s.alive,
      status: s.status,
      cwd: s.cwd,
      model: s.model,
      lastActivity: s.lastActivity,
    }));
  }

  supportedModels(): string[] | null {
    return this.models;
  }

  async shutdown(): Promise<void> {
    await this.store.stopAll();
  }
}
