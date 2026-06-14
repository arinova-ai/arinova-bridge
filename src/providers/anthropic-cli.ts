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
import type { Logger } from "../util/logger.js";
import { getErrorMessage } from "../util/errors.js";

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
  const msg = getErrorMessage(err);
  return (
    msg.includes("Claude process is not running") ||
    msg.includes("Claude process exited unexpectedly") ||
    msg.includes("Claude process error")
  );
}

/**
 * NOT_READY: the CLI is alive but pinned in RESPONDING/TOOL_USE — a hung turn
 * the response-timeout restart couldn't clear. The send never started, so
 * restarting the process and retrying once is safe (second line of defence to
 * the PtyProcess self-restart). RESPONSE_TIMEOUT is intentionally excluded:
 * that turn ran for 10 minutes, so it's surfaced rather than silently re-run.
 */
function isWedgedError(err: unknown): boolean {
  return getErrorMessage(err).includes("Cannot send: Claude is in state");
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
    const existing = this.store.getSession(conversationId);
    if (existing && existing.process.isAlive()) {
      if (opts?.reportToolCall) existing.process.setReportToolCall(opts.reportToolCall);
      return;
    }
    this.store.createSession(conversationId, {
      cwd: opts?.cwd,
      model: opts?.model,
      systemPrompt: opts?.systemPrompt,
      reportToolCall: opts?.reportToolCall,
    });
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
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
    this.sendChains.set(
      conversationId,
      resultPromise.catch(() => {}),
    );

    return resultPromise;
  }

  /**
   * Bump the session's lastActivity to "now". lastActivity is otherwise only
   * stamped at send-start, so a turn longer than idleTimeoutMs — or one that
   * triggered an in-place restart() — would leave a stale timestamp that the
   * idle sweep reaps right after recovery. Called on every turn completion.
   */
  private touchSession(conversationId: string): void {
    const entry = this.store.getSession(conversationId);
    if (entry) entry.lastActivity = Date.now();
  }

  /**
   * Wait for the process to be idle, then send without aborting.
   */
  private async idleSend(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal, reportToolCall, messageId } = opts;
    const content = buildContextPrefix(opts) + opts.content;

    let entry = this.store.getSession(conversationId);

    if (!entry || !entry.process.isAlive()) {
      entry = this.store.createSession(conversationId, { cwd, model, systemPrompt: opts.systemPrompt, reportToolCall });
    }

    // Wait for the process to finish any in-flight turn (Chat or previous A2A)
    while (entry.process.isBusy()) {
      await new Promise((r) => setTimeout(r, 500));
      // Re-check: session may have been destroyed while waiting
      const refreshed = this.store.getSession(conversationId);
      if (!refreshed || !refreshed.process.isAlive()) {
        entry = this.store.createSession(conversationId, {
          cwd,
          model,
          systemPrompt: opts.systemPrompt,
          reportToolCall,
        });
        break;
      }
      entry = refreshed;
    }

    // Keep the reporter fresh — covers reused-alive sessions and resume paths
    if (reportToolCall) entry.process.setReportToolCall(reportToolCall);
    entry.lastActivity = Date.now();

    try {
      const result = await entry.process.sendMessage(
        content,
        (text) => {
          onChunk(text);
        },
        signal,
        messageId,
      );

      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      };
    } finally {
      this.touchSession(conversationId);
    }
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
      return entry.process.sendMessage(
        content,
        (text) => {
          onChunk(text);
        },
        signal,
        messageId,
      );
    };

    let entry = this.store.getSession(conversationId);

    if (entry && entry.process.isAlive()) {
      // Abort any in-flight turn (e.g. cancel + immediate new message).
      // Ctrl+C takes a moment to land — sending before the CLI is back at
      // its prompt raises NOT_READY.
      if (entry.process.isBusy()) {
        entry.process.abortTurn();
        await entry.process.waitForIdle(5000);
      }
      entry.lastActivity = Date.now();
    } else {
      entry = this.store.createSession(conversationId, { cwd, model, systemPrompt: opts.systemPrompt, reportToolCall });
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
      // Don't retry user-aborted turns.
      if (signal?.aborted) throw err;

      const dead = isProcessDeadError(err);
      // A wedged-but-alive process (NOT_READY) recovers differently from a
      // dead one: createSession would orphan (leak) the still-running PTY, so
      // restart it in place — which stops the wedged CLI and resumes the same
      // session, preserving context. Only a dead process is respawned fresh.
      const wedged = !dead && isWedgedError(err);
      if (!dead && !wedged) throw err;

      let target = this.store.getSession(conversationId);
      if (wedged && target?.process.isAlive()) {
        await target.process.restart();
      } else {
        // Respawn fresh. If the fresh process also dies, surface the error.
        target = this.store.createSession(conversationId, {
          cwd,
          model,
          systemPrompt: opts.systemPrompt,
          reportToolCall,
        });
      }

      // Recover once. If the fresh/restarted process also fails, surface it.
      const result = await attempt(target);
      return {
        text: result.text,
        sessionId: result.sessionId,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      };
    } finally {
      // Runs on success, on recovery, and on a re-thrown error (e.g. a
      // ResponseTimeoutError after layer-1 already restarted the PTY) so the
      // recovered-but-idle process isn't reaped by the next idle-sweep tick.
      this.touchSession(conversationId);
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
      });
    }
  }

  async resumeSession(conversationId: string, sessionId: string, _opts?: SessionOpts): Promise<boolean> {
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

  setEnv(key: string, value: string): void {
    this.providerEnv[key] = value;
  }
}
