import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { CodexRpcClient } from "./rpc-client.js";
import type {
  InitializeParams,
  InitializeResult,
  ThreadStartParams,
  ThreadStartResult,
  ThreadResumeParams,
  TurnStartParams,
  TurnStartResult,
  TurnCompletedNotification,
  AgentMessageDeltaNotification,
  TokenUsageUpdatedNotification,
  RateLimitsUpdatedNotification,
  RateLimitSnapshot,
  TokenUsage,
  ApprovalResponse,
} from "./types.js";
import type { Logger } from "../util/logger.js";

export interface CodexAppServerOpts {
  codexPath?: string;
  env?: Record<string, string>;
  logger: Logger;
}

/** Known context window sizes (tokens) per model. Used as fallback when Codex doesn't report modelContextWindow. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.1-codex-max": 400_000,
  "gpt-5.1-codex-mini": 400_000,
};

interface ThreadState {
  threadId: string;
  conversationId: string;
  model: string | null;
  // Active turn
  turnResolve: ((text: string) => void) | null;
  turnReject: ((err: Error) => void) | null;
  turnOnChunk: ((text: string) => void) | null;
  turnText: string;
  // Token usage
  totalUsage: TokenUsage | null;
  lastUsage: TokenUsage | null;
  modelContextWindow: number | null;
}

export interface ContextUsage {
  contextTokens: number;
  contextWindow?: number;
}

export interface WindowUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Resolve the Codex binary path. */
function resolveCodexPath(envPath?: string): string {
  if (envPath) return envPath;
  try {
    return execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Codex binary not found. Install Codex CLI or set codexPath.");
  }
}

/**
 * Manages a single `codex app-server --listen stdio://` process.
 * Provides thread lifecycle, turn execution, and usage tracking.
 */
export class CodexAppServer {
  private opts: CodexAppServerOpts;
  private codexPath: string;
  private child: ChildProcess | null = null;
  private rpc: CodexRpcClient | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;

  // Thread state keyed by threadId
  private threads = new Map<string, ThreadState>();
  // conversationId → threadId lookup
  private convToThread = new Map<string, string>();

  // Account-level rate limit snapshot
  private rateLimitSnapshot: RateLimitSnapshot | null = null;

  constructor(opts: CodexAppServerOpts) {
    this.opts = opts;
    this.codexPath = resolveCodexPath(opts.codexPath);
  }

  // --- Process lifecycle ---

  /** Ensure the app-server is running and initialized. */
  async ensureReady(): Promise<void> {
    if (this.ready && this.child && !this.rpc?.isClosed) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const log = this.opts.logger;
    log.info("codex-app-server: spawning process...");

    const env = this.opts.env ? { ...process.env, ...this.opts.env } : undefined;

    const child = spawn(this.codexPath, [
      "app-server",
      "--listen", "stdio://",
      "-c", 'sandbox_mode="danger-full-access"',
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.child = child;

    // Capture stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) log.warn(`codex-app-server: [stderr] ${line.trim()}`);
      }
    });

    child.on("close", (code) => {
      log.warn(`codex-app-server: process exited code=${code}`);
      this.ready = false;
      this.child = null;
      // Reject all in-flight turns
      for (const state of this.threads.values()) {
        if (state.turnReject) {
          state.turnReject(new Error("App-server process crashed"));
          state.turnResolve = null;
          state.turnReject = null;
          state.turnOnChunk = null;
        }
      }
      this.rpc?.rejectAll("App-server process exited");
      this.rpc = null;
    });

    child.on("error", (err) => {
      log.error(`codex-app-server: spawn error: ${err.message}`);
      this.ready = false;
      this.child = null;
    });

    // Wire up JSON-RPC client
    const rpc = new CodexRpcClient(child.stdin!, child.stdout!, log);
    this.rpc = rpc;

    // Register notification handlers
    rpc.onNotification("item/agentMessage/delta", (params) => {
      this.onAgentDelta(params as AgentMessageDeltaNotification);
    });
    rpc.onNotification("turn/completed", (params) => {
      this.onTurnCompleted(params as TurnCompletedNotification);
    });
    rpc.onNotification("thread/tokenUsage/updated", (params) => {
      this.onTokenUsageUpdated(params as TokenUsageUpdatedNotification);
    });
    rpc.onNotification("account/rateLimits/updated", (params) => {
      this.onRateLimitsUpdated(params as RateLimitsUpdatedNotification);
    });

    // Auto-approve all server requests
    const autoApprove = (): ApprovalResponse => ({ decision: "accept" });
    rpc.onServerRequest("item/commandExecution/requestApproval", autoApprove);
    rpc.onServerRequest("item/fileChange/requestApproval", autoApprove);
    rpc.onServerRequest("item/applyPatch/requestApproval", autoApprove);
    rpc.onServerRequest("permissions/requestApproval", autoApprove);
    rpc.onServerRequest("tool/requestUserInput", autoApprove);
    rpc.onServerRequest("item/exec/requestApproval", autoApprove);

    // MCP elicitation uses a different response shape: { action: "accept" }
    const autoApproveElicitation = () => ({ action: "accept" });
    rpc.onServerRequest("mcpServer/elicitationRequest", autoApproveElicitation);
    rpc.onServerRequest("mcpServer/elicitation/request", autoApproveElicitation);

    // Initialization handshake
    const initParams: InitializeParams = {
      clientInfo: { name: "arinova-bridge", version: "0.1.0", title: null },
      capabilities: { experimentalApi: true },
    };

    log.info("codex-app-server: sending initialize...");
    await rpc.request<InitializeResult>("initialize", initParams);
    rpc.notify("initialized");

    this.ready = true;
    log.info("codex-app-server: ready");
  }

  isReady(): boolean {
    return this.ready;
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;

    const child = this.child;
    this.child = null;
    this.ready = false;

    this.rpc?.rejectAll("Shutting down");
    this.rpc = null;

    return new Promise((resolve) => {
      child.on("close", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 5000).unref();
    });
  }

  // --- Thread management ---

  /** Start a new thread or resume an existing one for a conversation. */
  async startThread(
    conversationId: string,
    opts: { cwd?: string; model?: string; resumeThreadId?: string; agentName?: string; env?: Record<string, string> },
  ): Promise<string> {
    await this.ensureReady();
    const log = this.opts.logger;

    const threadId = opts.resumeThreadId ?? this.convToThread.get(conversationId);

    if (threadId) {
      try {
        return await this.resumeThread(conversationId, threadId, opts);
      } catch (err) {
        log.warn(`codex-app-server: resume failed for ${threadId}, starting new thread: ${err}`);
        this.convToThread.delete(conversationId);
      }
    }

    // Start new thread
    const params: ThreadStartParams = {
      approvalPolicy: "never",
      persistFullHistory: true,
      ephemeral: false,
    };
    if (opts.model) params.model = opts.model;
    if (opts.cwd) params.cwd = opts.cwd;
    // Per-thread agent identity so CLI --source fallback works even when
    // multiple agents share this long-running CodexAppServer process.
    if (opts.agentName) {
      params.config = { env: { ...opts.env, ARINOVA_AGENT_NAME: opts.agentName } };
    } else if (opts.env) {
      params.config = { env: opts.env };
    }

    const result = await this.rpc!.request<ThreadStartResult>("thread/start", params);
    const newThreadId = result.thread.id;

    log.info(`codex-app-server: thread started id=${newThreadId.slice(0, 12)} conv=${conversationId}`);

    this.convToThread.set(conversationId, newThreadId);
    this.threads.set(newThreadId, {
      threadId: newThreadId,
      conversationId,
      model: opts.model ?? null,
      turnResolve: null,
      turnReject: null,
      turnOnChunk: null,
      turnText: "",
      totalUsage: null,
      lastUsage: null,
      modelContextWindow: null,
    });

    return newThreadId;
  }

  private async resumeThread(
    conversationId: string,
    threadId: string,
    opts: { cwd?: string; model?: string; agentName?: string; env?: Record<string, string> },
  ): Promise<string> {
    const params: ThreadResumeParams = {
      threadId,
      approvalPolicy: "never",
      persistFullHistory: true,
    };
    if (opts.model) params.model = opts.model;
    if (opts.cwd) params.cwd = opts.cwd;
    if (opts.agentName) {
      params.config = { env: { ...opts.env, ARINOVA_AGENT_NAME: opts.agentName } };
    } else if (opts.env) {
      params.config = { env: opts.env };
    }

    const result = await this.rpc!.request<ThreadStartResult>("thread/resume", params);
    const resumedId = result.thread.id;

    this.opts.logger.info(`codex-app-server: thread resumed id=${resumedId.slice(0, 12)} conv=${conversationId}`);

    this.convToThread.set(conversationId, resumedId);
    if (!this.threads.has(resumedId)) {
      this.threads.set(resumedId, {
        threadId: resumedId,
        conversationId,
        model: opts.model ?? null,
        turnResolve: null,
        turnReject: null,
        turnOnChunk: null,
        turnText: "",
        totalUsage: null,
        lastUsage: null,
        modelContextWindow: null,
      });
    }

    return resumedId;
  }

  /** Send a message and stream the response. */
  async sendMessage(
    conversationId: string,
    text: string,
    onChunk?: (text: string) => void,
    opts?: { cwd?: string; model?: string; agentName?: string; env?: Record<string, string> },
  ): Promise<{ text: string; threadId: string }> {
    const threadId = await this.startThread(conversationId, {
      cwd: opts?.cwd,
      model: opts?.model,
      agentName: opts?.agentName,
      env: opts?.env,
      resumeThreadId: this.convToThread.get(conversationId),
    });

    const state = this.threads.get(threadId);
    if (!state) throw new Error("Thread state not found");

    if (state.turnResolve) {
      throw new Error("Another turn is in-flight for this thread");
    }

    state.turnText = "";
    state.turnOnChunk = onChunk ?? null;

    const turnParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    };

    return new Promise<{ text: string; threadId: string }>((resolve, reject) => {
      state.turnResolve = (responseText) => resolve({ text: responseText, threadId });
      state.turnReject = reject;

      this.rpc!.request<TurnStartResult>("turn/start", turnParams).catch((err) => {
        state.turnResolve = null;
        state.turnReject = null;
        state.turnOnChunk = null;
        reject(err);
      });
    });
  }

  /** Interrupt an in-flight turn. */
  interrupt(conversationId: string): void {
    const threadId = this.convToThread.get(conversationId);
    if (!threadId) return;

    const state = this.threads.get(threadId);
    if (!state?.turnReject) return;

    // Try to cancel the turn
    this.rpc?.request("turn/cancel", { threadId }).catch(() => {
      // Ignore cancel errors
    });

    const reject = state.turnReject;
    state.turnResolve = null;
    state.turnReject = null;
    state.turnOnChunk = null;
    reject(new Error("Turn interrupted"));
  }

  /** Clear thread mapping for a conversation (for /new). */
  clearThread(conversationId: string): void {
    const threadId = this.convToThread.get(conversationId);
    if (threadId) {
      this.threads.delete(threadId);
      this.convToThread.delete(conversationId);
    }
  }

  /** Get the thread ID for a conversation. */
  getThreadId(conversationId: string): string | undefined {
    return this.convToThread.get(conversationId);
  }

  // --- Usage getters ---

  getRateLimits(): RateLimitSnapshot | null {
    return this.rateLimitSnapshot;
  }

  getContextUsage(conversationId: string): ContextUsage | null {
    const threadId = this.convToThread.get(conversationId);
    if (!threadId) return null;
    const state = this.threads.get(threadId);
    if (!state) return null;
    const usage = state.lastUsage ?? state.totalUsage;
    if (!usage) return null;

    const contextWindow =
      state.modelContextWindow ??
      (state.model ? MODEL_CONTEXT_WINDOWS[state.model] : undefined) ??
      undefined;

    return {
      contextTokens: usage.inputTokens + usage.cachedInputTokens,
      contextWindow,
    };
  }

  getTokenUsage(conversationId: string): { total: TokenUsage; last: TokenUsage } | null {
    const threadId = this.convToThread.get(conversationId);
    if (!threadId) return null;
    const state = this.threads.get(threadId);
    if (!state?.totalUsage || !state.lastUsage) return null;
    return { total: state.totalUsage, last: state.lastUsage };
  }

  /** List all active thread IDs with their conversation IDs. */
  listThreads(): Array<{ threadId: string; conversationId: string }> {
    const result: Array<{ threadId: string; conversationId: string }> = [];
    for (const [convId, threadId] of this.convToThread) {
      result.push({ threadId, conversationId: convId });
    }
    return result;
  }

  // --- Notification handlers ---

  private onAgentDelta(params: AgentMessageDeltaNotification): void {
    const state = this.findThreadByThreadId(params.threadId);
    if (!state) return;

    state.turnText += params.delta;
    state.turnOnChunk?.(params.delta);
  }

  private onTurnCompleted(params: TurnCompletedNotification): void {
    const state = this.findThreadByThreadId(params.threadId);
    if (!state) return;

    const resolve = state.turnResolve;
    const reject = state.turnReject;
    state.turnResolve = null;
    state.turnReject = null;
    state.turnOnChunk = null;

    if (params.turn.status !== "completed" && params.turn.error) {
      const errMsg = typeof params.turn.error === 'string' ? params.turn.error : JSON.stringify(params.turn.error);
      reject?.(new Error(`Turn failed: ${errMsg}`));
    } else {
      resolve?.(state.turnText || "Done.");
    }
  }

  private onTokenUsageUpdated(params: TokenUsageUpdatedNotification): void {
    const state = this.findThreadByThreadId(params.threadId);
    if (!state) return;

    state.totalUsage = params.tokenUsage.total;
    state.lastUsage = params.tokenUsage.last;
    if (params.tokenUsage.modelContextWindow !== null) {
      state.modelContextWindow = params.tokenUsage.modelContextWindow;
    }
  }

  private onRateLimitsUpdated(params: RateLimitsUpdatedNotification): void {
    this.rateLimitSnapshot = params.rateLimits;
    const p = params.rateLimits.primary;
    const s = params.rateLimits.secondary;
    this.opts.logger.info(
      `codex-app-server: rate limits updated — ` +
      `primary=${p?.usedPercent ?? "?"}% resetsAt=${p?.resetsAt ?? "null"} ` +
      `secondary=${s?.usedPercent ?? "?"}% resetsAt=${s?.resetsAt ?? "null"}`,
    );
  }

  private findThreadByThreadId(threadId: string): ThreadState | undefined {
    return this.threads.get(threadId);
  }
}
