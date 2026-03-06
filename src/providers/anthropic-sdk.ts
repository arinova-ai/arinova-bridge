import type {
  Provider,
  SendMessageOpts,
  SendResult,
  SessionOpts,
  SessionInfo,
  CostInfo,
  SessionListEntry,
} from "./types.js";
import { buildContextPrefix } from "../util/context.js";
import type { Logger } from "../util/logger.js";

export interface AnthropicSdkConfig {
  providerId: string;
  displayName: string;
  apiKey: string;
  defaultModel?: string;
  defaultCwd: string;
  maxSessions: number;
  idleTimeoutMs: number;
  mcpConfigPath?: string;
  models?: string[];
}

interface SdkSession {
  conversationId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  lastActivity: number;
  totalCostUsd: number;
  abortController: AbortController | null;
}

/**
 * anthropic-sdk provider: uses @anthropic-ai/claude-code SDK directly.
 * API Key based, pay-per-use.
 */
export class AnthropicSdkProvider implements Provider {
  readonly id: string;
  readonly type = "anthropic-sdk";
  readonly displayName: string;

  private config: AnthropicSdkConfig;
  private logger: Logger;
  private sessions = new Map<string, SdkSession>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AnthropicSdkConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.config = config;
    this.logger = logger;
    this.startIdleSweep();
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, cwd, model, onChunk, signal } = opts;
    const content = buildContextPrefix(opts) + opts.content;

    // Lazy import to avoid requiring the SDK if not used
    const { query } = await import("@anthropic-ai/claude-code");

    const session = this.getOrCreateSession(conversationId, cwd, model);
    session.lastActivity = Date.now();

    const abortController = new AbortController();
    session.abortController = abortController;

    // Propagate external abort signal to internal controller
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const effectiveCwd = cwd ?? session.cwd;
    const effectiveModel = model ?? session.model ?? this.config.defaultModel;

    try {
      const stream = query({
        prompt: content,
        options: {
          abortController,
          cwd: effectiveCwd,
          model: effectiveModel,
          maxTurns: Infinity,
          permissionMode: "dangerouslySkipPermissions" as never,
          // Pass API key via environment
          env: {
            ANTHROPIC_API_KEY: this.config.apiKey,
          },
          resume: session.sessionId.startsWith("sdk-") ? undefined : session.sessionId,
        },
      });

      let resultText = "";
      let newSessionId = session.sessionId;

      for await (const message of stream) {
        // Update session ID from messages
        if ("session_id" in message && typeof message.session_id === "string") {
          newSessionId = message.session_id;
        }

        if (message.type === "stream_event") {
          // Handle streaming text deltas
          const event = message.event as Record<string, unknown>;
          if (event.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              const text = delta.text as string;
              resultText += text;
              onChunk(text);
            }
          }
        } else if (message.type === "result") {
          const result = message as Record<string, unknown>;
          if (typeof result.total_cost_usd === "number") {
            session.totalCostUsd += result.total_cost_usd as number;
          }
          // Use result text if we didn't get streaming text
          if (!resultText && typeof result.result === "string") {
            resultText = result.result as string;
          }
        }
      }

      session.sessionId = newSessionId;
      session.abortController = null;
      signal?.removeEventListener("abort", onAbort);

      return {
        text: resultText || "Done.",
        sessionId: newSessionId,
      };
    } catch (err) {
      session.abortController = null;
      signal?.removeEventListener("abort", onAbort);
      throw err;
    }
  }

  interrupt(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (session?.abortController) {
      session.abortController.abort();
      session.abortController = null;
    }
  }

  async resetSession(conversationId: string, opts?: SessionOpts): Promise<void> {
    this.sessions.delete(conversationId);
    if (opts?.cwd || opts?.model) {
      this.getOrCreateSession(conversationId, opts.cwd, opts.model);
    }
  }

  async resumeSession(
    conversationId: string,
    sessionId: string,
    opts?: SessionOpts,
  ): Promise<boolean> {
    // Create a new session that will resume from the given session ID
    this.sessions.delete(conversationId);
    const session = this.getOrCreateSession(conversationId, opts?.cwd, opts?.model);
    session.sessionId = sessionId;
    return true;
  }

  getSessionInfo(conversationId: string): SessionInfo | null {
    const session = this.sessions.get(conversationId);
    if (!session) return null;

    return {
      sessionId: session.sessionId,
      alive: true,
      cwd: session.cwd,
      model: session.model,
    };
  }

  getCostInfo(conversationId: string): CostInfo | null {
    const session = this.sessions.get(conversationId);
    if (!session) return null;

    return {
      totalCostUsd: session.totalCostUsd,
    };
  }

  listSessions(): SessionListEntry[] {
    const result: SessionListEntry[] = [];
    for (const [convId, session] of this.sessions) {
      result.push({
        providerId: this.id,
        sessionId: session.sessionId,
        conversationId: convId,
        alive: true,
        status: session.abortController ? "busy" : "ready",
        cwd: session.cwd,
        model: session.model,
        lastActivity: session.lastActivity,
      });
    }
    return result;
  }

  supportedModels(): string[] | null {
    return this.config.models ?? null;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }
    this.sessions.clear();
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private getOrCreateSession(
    conversationId: string,
    cwd?: string,
    model?: string,
  ): SdkSession {
    let session = this.sessions.get(conversationId);
    if (session) return session;

    session = {
      conversationId,
      sessionId: `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      cwd: cwd ?? this.config.defaultCwd,
      model: model ?? this.config.defaultModel,
      lastActivity: Date.now(),
      totalCostUsd: 0,
      abortController: null,
    };
    this.sessions.set(conversationId, session);
    return session;
  }

  private startIdleSweep(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, session] of this.sessions) {
        if (
          !session.abortController &&
          now - session.lastActivity > this.config.idleTimeoutMs
        ) {
          this.logger.info(`anthropic-sdk: idle timeout for ${key}`);
          this.sessions.delete(key);
        }
      }
    }, 60_000);
    this.idleTimer.unref();
  }
}
