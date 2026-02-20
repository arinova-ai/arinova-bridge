import type {
  Provider,
  SendMessageOpts,
  SendResult,
  SessionOpts,
  SessionInfo,
  CostInfo,
  SessionListEntry,
} from "./types.js";
import { SessionStore } from "../claude/session-store.js";
import type { Logger } from "../util/logger.js";

export interface AnthropicCliConfig {
  claudePath: string;
  mcpConfigPath?: string;
  defaultCwd: string;
  maxSessions: number;
  idleTimeoutMs: number;
}

/**
 * anthropic-oauth provider: spawns a persistent `claude` CLI process
 * using Consumer OAuth (Max/Pro subscription).
 */
export class AnthropicCliProvider implements Provider {
  readonly id = "anthropic-oauth" as const;
  readonly displayName = "Anthropic OAuth (Claude CLI)";

  private store: SessionStore;
  private defaultCwd: string;

  constructor(config: AnthropicCliConfig, logger: Logger) {
    this.defaultCwd = config.defaultCwd;
    this.store = new SessionStore(
      {
        claudePath: config.claudePath,
        mcpConfigPath: config.mcpConfigPath,
        defaultCwd: config.defaultCwd,
        maxSessions: config.maxSessions,
        idleTimeoutMs: config.idleTimeoutMs,
      },
      logger,
    );
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, content, cwd, model, onChunk } = opts;

    let entry = this.store.getSession(conversationId);

    if (entry && entry.process.isAlive()) {
      entry.lastActivity = Date.now();
    } else {
      entry = this.store.createSession(conversationId, { cwd, model });
    }

    const result = await entry.process.sendMessage(content, (text) => {
      onChunk(text);
    });

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

  listSessions(): SessionListEntry[] {
    return this.store.listSessions().map((s) => ({
      providerId: this.id,
      sessionId: s.sessionId,
      conversationId: s.conversationId,
      alive: s.alive,
      cwd: s.cwd,
      model: s.model,
      lastActivity: s.lastActivity,
    }));
  }

  supportedModels(): string[] | null {
    return ["opus", "sonnet", "haiku"];
  }

  async shutdown(): Promise<void> {
    await this.store.stopAll();
  }
}
