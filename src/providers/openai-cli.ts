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
  resolveCodexBinary,
  spawnCodexExec,
  spawnCodexResume,
  interruptProcess,
  waitForExit,
} from "../codex/process.js";
import { processTurn } from "../codex/events.js";
import type { Logger } from "../util/logger.js";

export interface OpenAICliConfig {
  providerId: "openai-api" | "openai-oauth";
  displayName: string;
  codexPath?: string;
  apiKey?: string;
  defaultCwd: string;
  dbPath: string;
}

const RECOVERY_PROMPT = "請總結你目前的進度和最終結果";

/**
 * OpenAI CLI provider: spawns ephemeral `codex` CLI processes.
 * Works for both openai-api (API key) and openai-oauth modes.
 */
export class OpenAICliProvider implements Provider {
  readonly id: ProviderId;
  readonly displayName: string;

  private codexPath: string;
  private apiKey?: string;
  private defaultCwd: string;
  private db: BridgeDb;
  private queue: ConversationQueue;
  private logger: Logger;

  constructor(config: OpenAICliConfig, logger: Logger) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.apiKey = config.apiKey;
    this.defaultCwd = config.defaultCwd;
    this.logger = logger;
    this.queue = new ConversationQueue();

    this.codexPath = resolveCodexBinary(config.codexPath);
    this.db = initDb(config.dbPath);

    // Run crash recovery
    this.recoverSessions().catch((err) => {
      logger.error(`openai-cli: crash recovery failed: ${err}`);
    });
  }

  async sendMessage(opts: SendMessageOpts): Promise<SendResult> {
    const { conversationId, content, cwd, model, onChunk } = opts;

    return new Promise<SendResult>((resolve, reject) => {
      this.queue.enqueue(conversationId, async () => {
        try {
          const result = await this.runCodexTurn(
            conversationId,
            content,
            cwd,
            model,
            onChunk,
          );
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  interrupt(conversationId: string): void {
    const child = this.queue.activeProcesses.get(conversationId);
    if (child) {
      interruptProcess(child);
    }
  }

  async resetSession(conversationId: string, opts?: SessionOpts): Promise<void> {
    const conv = this.db.getConversation(conversationId);
    if (conv) {
      this.db.resetConversation(conversationId, opts?.cwd ?? null);
    } else {
      this.db.upsertConversation(conversationId, {
        status: "idle",
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
      status: "idle",
    });
    return true;
  }

  getSessionInfo(conversationId: string): SessionInfo | null {
    const conv = this.db.getConversation(conversationId);
    if (!conv || !conv.threadId) return null;

    return {
      sessionId: conv.threadId,
      alive: conv.status === "running",
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
    return all.map((conv) => ({
      providerId: this.id,
      sessionId: conv.threadId ?? "",
      conversationId: conv.convId,
      alive: conv.status === "running",
      cwd: conv.cwd ?? this.defaultCwd,
      model: conv.model ?? undefined,
    }));
  }

  supportedModels(): string[] {
    return [
      "codex-mini-latest",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "o4-mini",
      "o3",
    ];
  }

  async shutdown(): Promise<void> {
    // Interrupt all active processes
    for (const [, child] of this.queue.activeProcesses) {
      interruptProcess(child);
    }
  }

  private async runCodexTurn(
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

    this.db.upsertConversation(conversationId, { status: "running" });

    const isResume = !isRetry && !!conv?.threadId;
    let codex;
    if (isResume) {
      codex = spawnCodexResume(this.codexPath, conv.threadId!, content, {
        cwd: effectiveCwd,
        model: effectiveModel,
      });
    } else {
      codex = spawnCodexExec(this.codexPath, content, {
        cwd: effectiveCwd,
        model: effectiveModel,
      });
    }

    this.queue.activeProcesses.set(conversationId, codex.child);

    try {
      const result = await processTurn(codex.events, {
        onChunk: (chunk) => onChunk?.(chunk),
        onComplete: () => {},
        onError: () => {},
      });

      if (result.threadId) {
        this.db.upsertConversation(conversationId, {
          threadId: result.threadId,
        });
      }

      if (result.usage) {
        this.db.addTokenUsage(conversationId, {
          inputTokens: result.usage.input_tokens,
          cachedInputTokens: result.usage.cached_input_tokens,
          outputTokens: result.usage.output_tokens,
        });
      }

      const exit = await waitForExit(codex.child);
      const stderr = codex.stderr();
      const failed = exit.code !== 0 && exit.code !== null;
      const noOutput = !result.finalResponse?.trim();

      if (stderr) {
        this.logger.error(`openai-cli: stderr for ${conversationId}: ${stderr}`);
      }

      // Resume failed with no output → auto-retry as fresh exec
      if (isResume && noOutput && !isRetry) {
        this.logger.warn(`openai-cli: resume produced no output for ${conversationId}, retrying as new exec`);
        this.db.resetConversation(conversationId, effectiveCwd);
        this.queue.activeProcesses.delete(conversationId);
        return this.runCodexTurn(conversationId, content, cwd, model, onChunk, true);
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
          throw new Error(`Codex 執行失敗:\n${hint}`);
        }
      } else {
        this.db.updateStatus(conversationId, "idle");
      }

      return {
        text: result.finalResponse || "Done.",
        sessionId: result.threadId ?? undefined,
      };
    } finally {
      this.queue.activeProcesses.delete(conversationId);
    }
  }

  private async recoverSessions(): Promise<void> {
    const stale = this.db.getRunningConversations();
    if (stale.length === 0) return;

    this.logger.info(`openai-cli: recovering ${stale.length} interrupted session(s)...`);
    for (const conv of stale) {
      if (!conv.threadId) {
        this.db.updateStatus(conv.convId, "error");
        continue;
      }
      try {
        await this.recoverSession(conv.threadId, conv.convId);
        this.logger.info(`openai-cli: recovered ${conv.convId} (thread ${conv.threadId})`);
      } catch (err) {
        this.logger.error(`openai-cli: recovery failed for ${conv.convId}: ${err}`);
        this.db.updateStatus(conv.convId, "error");
      }
    }
  }

  private async recoverSession(threadId: string, convId: string): Promise<void> {
    const conv = this.db.getConversation(convId);
    const cwd = conv?.cwd ?? this.defaultCwd;
    const model = conv?.model ?? undefined;

    const codex = spawnCodexResume(this.codexPath, threadId, RECOVERY_PROMPT, { cwd, model });

    for await (const event of codex.events) {
      if (event.type === "turn.completed" && event.usage) {
        this.db.addTokenUsage(convId, {
          inputTokens: event.usage.input_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
          outputTokens: event.usage.output_tokens,
        });
      }
    }

    await waitForExit(codex.child);
    this.db.updateStatus(convId, "idle");
  }
}
