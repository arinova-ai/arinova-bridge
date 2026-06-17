import type {
  Provider,
  SendMessageOpts,
  SendResult,
  SessionOpts,
  SessionInfo,
  CostInfo,
  UsageInfo,
  SessionListEntry,
  WarmupOpts,
} from "./types.js";
import { SessionStore } from "../claude/session-store.js";
import { buildContextPrefix } from "../util/context.js";
import { resolveEffortForProvider } from "../util/effort.js";
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
  configDir?: string;
}

/** Errors raised from ClaudeProcess when the CLI is dead or dies mid-turn. */
function isProcessDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Claude process is not running") ||
    msg.includes("Claude process exited unexpectedly") ||
    msg.includes("Claude process error")
  );
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
  private providerEnv: Record<string, string>;
  /** Per-conversation promise chain for queued (non-aborting) sends. */
  private sendChains = new Map<string, Promise<unknown>>();
  /**
   * Per-conversation resolved `--effort` level. `--effort` is a spawn-time CLI
   * flag, so it's applied when a session's process is (re)created. Recording it
   * here keeps it sticky across respawns and `/model` resets, which build a
   * fresh process without seeing the original SendMessageOpts.
   */
  private effortByConv = new Map<string, string>();

  /** Resolve + remember the effort for a conversation; returns the level to spawn with. */
  private recordEffort(conversationId: string, raw: unknown): string | undefined {
    const level = resolveEffortForProvider(raw, this.type);
    if (level) this.effortByConv.set(conversationId, level);
    return this.effortByConv.get(conversationId);
  }

  constructor(config: AnthropicCliConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.defaultCwd = config.defaultCwd;
    this.models = config.models ?? null;
    this.providerEnv = config.env ?? {};
    this.store = new SessionStore(
      {
        claudePath: config.claudePath,
        mcpConfigPath: config.mcpConfigPath,
        defaultCwd: config.defaultCwd,
        maxSessions: config.maxSessions,
        idleTimeoutMs: config.idleTimeoutMs,
        env: this.providerEnv,
      },
      logger,
    );
  }

  setAgentMcpConfig(agentName: string, mcpConfigPath: string): void {
    this.store.setAgentMcpConfig(agentName, mcpConfigPath);
  }

  warmup(conversationId: string, opts?: WarmupOpts): void {
    const effort = this.recordEffort(conversationId, opts?.effort);
    const existing = this.store.getSession(conversationId);
    if (existing && existing.process.isAlive()) {
      if (opts?.reportToolCall) existing.process.setReportToolCall(opts.reportToolCall);
      return;
    }
    this.store.createSession(conversationId, {
      cwd: opts?.cwd,
      model: opts?.model,
      effort,
      systemPrompt: opts?.systemPrompt,
      reportToolCall: opts?.reportToolCall,
    });
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    this.recordEffort(opts.conversationId, opts.effort);
    if (opts.queue) {
      return this.queuedSend(opts);
    }
    return this.directSend(opts);
  }

  /**
   * Queue-mode: waits for the process to be idle before sending.
   * Unlike directSend, it never aborts the current turn.
   * Used by A2A dispatch so messages are never lost.
   */
  private queuedSend(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId } = opts;
    const prev = this.sendChains.get(conversationId) ?? Promise.resolve();

    const resultPromise = prev.then(() => this.idleSend(opts));

    // Store the chain; swallow errors so a failed send doesn't block the queue
    this.sendChains.set(conversationId, resultPromise.catch(() => {}));

    return resultPromise;
  }

  /**
   * Wait for the process to be idle, then send without aborting.
   */
  private async idleSend(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal, reportToolCall, messageId } = opts;
    const content = buildContextPrefix(opts) + opts.content;

    let entry = this.store.getSession(conversationId);

    if (!entry || !entry.process.isAlive()) {
      entry = this.store.createSession(conversationId, { cwd, model, effort: this.effortByConv.get(conversationId), systemPrompt: opts.systemPrompt, reportToolCall });
    }

    // Wait for the process to finish any in-flight turn (Chat or previous A2A)
    while (entry.process.isBusy()) {
      await new Promise((r) => setTimeout(r, 500));
      // Re-check: session may have been destroyed while waiting
      const refreshed = this.store.getSession(conversationId);
      if (!refreshed || !refreshed.process.isAlive()) {
        entry = this.store.createSession(conversationId, { cwd, model, effort: this.effortByConv.get(conversationId), systemPrompt: opts.systemPrompt, reportToolCall });
        break;
      }
      entry = refreshed;
    }

    // Keep the reporter fresh — covers reused-alive sessions and resume paths
    if (reportToolCall) entry.process.setReportToolCall(reportToolCall);
    entry.lastActivity = Date.now();

    const result = await entry.process.sendMessage(content, (text) => {
      onChunk(text);
    }, signal, messageId);

    return {
      text: result.text,
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    };
  }

  /**
   * Direct send: aborts any in-flight turn (Chat behavior — user cancels).
   *
   * If the underlying Claude process has died (or dies during the send),
   * respawn once and retry. This keeps the task path from getting stuck
   * on a dead agent after a CLI crash.
   */
  private async directSend(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal, reportToolCall, messageId } = opts;
    const content = buildContextPrefix(opts) + opts.content;

    const attempt = async (entry: ReturnType<SessionStore["getSession"]>) => {
      if (!entry) throw new Error("Claude process is not running");
      // Signal is managed inside ClaudeProcess — it clears the old listener
      // before attaching the new one, preventing stale signals from aborting
      // the wrong turn.
      return entry.process.sendMessage(content, (text) => {
        onChunk(text);
      }, signal, messageId);
    };

    let entry = this.store.getSession(conversationId);

    if (entry && entry.process.isAlive()) {
      // Abort any in-flight turn (e.g. cancel + immediate new message)
      if (entry.process.isBusy()) {
        entry.process.abortTurn();
      }
      entry.lastActivity = Date.now();
    } else {
      entry = this.store.createSession(conversationId, { cwd, model, effort: this.effortByConv.get(conversationId), systemPrompt: opts.systemPrompt, reportToolCall });
    }

    // Keep the reporter fresh — covers reused-alive sessions and resume paths
    if (reportToolCall) entry.process.setReportToolCall(reportToolCall);

    try {
      const result = await attempt(entry);
      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      };
    } catch (err) {
      // Don't retry user-aborted turns or non-process-death errors.
      if (signal?.aborted) throw err;
      if (!isProcessDeadError(err)) throw err;

      // Respawn once. If the fresh process also dies, surface the error.
      const respawned = this.store.createSession(conversationId, {
        cwd,
        model,
        effort: this.effortByConv.get(conversationId),
        systemPrompt: opts.systemPrompt,
        reportToolCall,
      });
      const result = await attempt(respawned);
      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      };
    }
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
        // Keep the agent's effort across a /model or cwd reset (spawn-time flag).
        effort: this.effortByConv.get(conversationId),
      });
    }
  }

  async resumeSession(
    conversationId: string,
    sessionId: string,
    opts?: SessionOpts,
  ): Promise<boolean> {
    const entry = await this.store.resumeSession(
      conversationId,
      sessionId,
      this.effortByConv.get(conversationId),
    );
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

  setEnv(key: string, value: string): void {
    this.providerEnv[key] = value;
  }
}
