import type {
  Provider,
  ProviderId,
  SendMessageOpts,
  SendResult,
  SessionOpts,
  SessionInfo,
  CostInfo,
  SessionListEntry,
} from "./types.js";
import { initDb, type BridgeDb } from "../codex/db.js";
import { ConversationQueue } from "../codex/queue.js";
import {
  resolveGeminiBinary,
  spawnGeminiExec,
  spawnGeminiResume,
  interruptGeminiProcess,
  waitForGeminiExit,
} from "../gemini/process.js";
import { processGeminiTurn } from "../gemini/events.js";
import type { Logger } from "../util/logger.js";

export interface GeminiCliConfig {
  providerId: string;
  displayName: string;
  geminiPath?: string;
  apiKey?: string;
  defaultCwd: string;
  dbPath: string;
  env?: Record<string, string>;
  models?: string[];
}

/**
 * Gemini CLI provider: spawns ephemeral `gemini` CLI processes.
 * Google OAuth is handled internally by the Gemini CLI.
 */
export class GeminiCliProvider implements Provider {
  readonly id: string;
  readonly type = "gemini-cli";
  readonly displayName: string;

  private geminiPath: string;
  private defaultCwd: string;
  private db: BridgeDb;
  private queue: ConversationQueue;
  private logger: Logger;
  private customEnv?: Record<string, string>;
  private modelList: string[];

  constructor(config: GeminiCliConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.defaultCwd = config.defaultCwd;
    this.logger = logger;
    this.queue = new ConversationQueue();
    this.customEnv = config.env;
    this.modelList = config.models ?? [
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ];

    this.geminiPath = resolveGeminiBinary(config.geminiPath);
    this.db = initDb(config.dbPath);
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, content, cwd, model, onChunk, signal } = opts;

    const onAbort = () => this.interrupt(conversationId);
    signal?.addEventListener("abort", onAbort, { once: true });

    return new Promise<SendResult>((resolve, reject) => {
      this.queue.enqueue(conversationId, async () => {
        try {
          const result = await this.runGeminiTurn(
            conversationId,
            content,
            cwd,
            model,
            onChunk,
          );
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      });
    });
  }

  interrupt(conversationId: string): void {
    const child = this.queue.activeProcesses.get(conversationId);
    if (child) {
      interruptGeminiProcess(child);
    }
  }

  async resetSession(conversationId: string, opts?: SessionOpts): Promise<void> {
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
    if (!conv || !conv.threadId) return null;

    return {
      sessionId: conv.threadId,
      alive: conv.status === "busy",
      cwd: conv.cwd ?? this.defaultCwd,
      model: conv.model ?? undefined,
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

  listSessions(): SessionListEntry[] {
    const all = this.db.getAllConversations();
    return all.map((conv) => {
      const hasThread = !!conv.threadId;
      const status = conv.status === "error" ? "error" as const
        : conv.status === "busy" ? "busy" as const
        : "ready" as const;
      return {
        providerId: this.id,
        sessionId: conv.threadId ?? "",
        conversationId: conv.convId,
        alive: hasThread && status !== "error",
        status,
        cwd: conv.cwd ?? this.defaultCwd,
        model: conv.model ?? undefined,
      };
    });
  }

  supportedModels(): string[] {
    return this.modelList;
  }

  async shutdown(): Promise<void> {
    for (const [, child] of this.queue.activeProcesses) {
      interruptGeminiProcess(child);
    }
  }

  private async runGeminiTurn(
    conversationId: string,
    content: string,
    cwd?: string,
    model?: string,
    onChunk?: (text: string) => void,
    isRetry = false,
  ): Promise<SendResult> {
    const conv = this.db.getConversation(conversationId);
    const effectiveCwd = cwd ?? conv?.cwd ?? this.defaultCwd;
    const effectiveModel = model ?? conv?.model ?? undefined;

    this.db.upsertConversation(conversationId, { status: "busy" });

    const isResume = !isRetry && !!conv?.threadId;
    let gemini;
    if (isResume) {
      gemini = spawnGeminiResume(this.geminiPath, conv.threadId!, content, {
        cwd: effectiveCwd,
        model: effectiveModel,
        env: this.customEnv,
      });
    } else {
      gemini = spawnGeminiExec(this.geminiPath, content, {
        cwd: effectiveCwd,
        model: effectiveModel,
        env: this.customEnv,
      });
    }

    this.queue.activeProcesses.set(conversationId, gemini.child);

    try {
      const result = await processGeminiTurn(gemini.events, {
        onChunk: (chunk) => onChunk?.(chunk),
        onComplete: () => {},
        onError: () => {},
      });

      if (result.sessionId) {
        this.db.upsertConversation(conversationId, {
          threadId: result.sessionId,
        });
      }

      if (result.usage) {
        this.db.addTokenUsage(conversationId, {
          inputTokens: result.usage.inputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          outputTokens: result.usage.outputTokens,
        });
      }

      const exit = await waitForGeminiExit(gemini.child);
      const stderr = gemini.stderr();
      const failed = exit.code !== 0 && exit.code !== null;
      const noOutput = !result.finalResponse?.trim();

      if (stderr) {
        this.logger.error(`gemini-cli: stderr for ${conversationId}: ${stderr}`);
      }

      // Resume failed with no output → auto-retry as fresh exec
      if (isResume && noOutput && !isRetry) {
        this.logger.warn(`gemini-cli: resume produced no output for ${conversationId}, retrying as new exec`);
        this.db.resetConversation(conversationId, effectiveCwd);
        this.queue.activeProcesses.delete(conversationId);
        return this.runGeminiTurn(conversationId, content, cwd, model, onChunk, true);
      }

      if (result.error) {
        this.db.updateStatus(conversationId, "error");
        throw new Error(result.error);
      }

      if (failed || (noOutput && stderr)) {
        this.db.updateStatus(conversationId, "error");

        if (noOutput) {
          const hint = stderr
            ? stderr.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n")
            : `exit code ${exit.code}`;
          throw new Error(`Gemini CLI failed:\n${hint}`);
        }
      } else {
        this.db.updateStatus(conversationId, "ready");
      }

      return {
        text: result.finalResponse || "Done.",
        sessionId: result.sessionId ?? undefined,
      };
    } finally {
      this.queue.activeProcesses.delete(conversationId);
    }
  }
}
