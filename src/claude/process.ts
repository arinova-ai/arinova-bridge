import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "../util/logger.js";

export type ClaudeProcessOptions = {
  claudePath?: string;
  mcpConfigPath?: string;
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  resumeSessionId?: string;
  compact?: boolean;
  env?: Record<string, string>;
  logger: Logger;
};

export type RateLimitInfo = {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  /** 0-1 utilization from Anthropic API headers (may be absent at low usage) */
  utilization?: number;
};

export type WindowUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  resetsAt: number;
};

export type ContextUsage = {
  contextTokens: number;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type SendMessageResult = {
  text: string;
  sessionId: string;
  durationMs?: number;
  numTurns?: number;
};

const DEFAULT_CLAUDE_PATH = "claude";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_DRAIN_TIMEOUT_MS = 5000;

/**
 * Persistent Claude Code CLI process using the bidirectional stream-json protocol.
 *
 * Keeps a single long-running `claude` process and sends/receives
 * newline-delimited JSON on stdin/stdout. Only prose text is tracked.
 */
export class ClaudeProcess {
  private child: ChildProcess | null = null;
  private opts: ClaudeProcessOptions;
  private lineBuf = "";
  private sessionId = "";
  private alive = false;
  private totalCostUsd = 0;
  private stderrBuf: string[] = [];

  // Latest snapshot (persisted across turns for /usage)
  private rateLimits = new Map<string, RateLimitInfo>();
  private lastContext: ContextUsage | undefined;
  private resolvedModel: string | undefined;

  // 5H window usage tracking
  private windowResetsAt = 0;
  private windowInputTokens = 0;
  private windowOutputTokens = 0;
  private windowCostUsd = 0;
  private windowTurns = 0;

  // Per-turn usage accumulators
  private turnInputTokens = 0;
  private turnOutputTokens = 0;
  private turnCacheRead = 0;
  private turnCacheCreation = 0;
  private turnCostUsd: number | undefined;
  private turnNumTurns: number | undefined;
  private turnDurationMs: number | undefined;
  private turnContextTokens = 0;
  private turnContextWindow: number | undefined;
  private turnMaxOutputTokens: number | undefined;
  private turnRateLimits = new Map<string, RateLimitInfo>();

  // Per-turn state
  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;
  private turnProseText = "";
  private turnOnText: ((text: string) => void) | null = null;
  private turnTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Number of aborted turn results still expected from the process. */
  private staleResults = 0;
  private staleDrainTimer: ReturnType<typeof setTimeout> | null = null;
  /** Signal and listener for the current turn (cleared on abort/complete). */
  private turnSignal: AbortSignal | null = null;
  private turnSignalListener: (() => void) | null = null;

  constructor(opts: ClaudeProcessOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.child) return;

    const claudePath = this.opts.claudePath ?? DEFAULT_CLAUDE_PATH;
    const log = this.opts.logger;

    const argv: string[] = [
      "-p", "",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];

    if (this.opts.model) {
      argv.push("--model", this.opts.model);
    }

    if (this.opts.mcpConfigPath) {
      argv.push("--mcp-config", this.opts.mcpConfigPath);
    }

    if (this.opts.systemPrompt) {
      argv.push("--append-system-prompt", this.opts.systemPrompt);
    }

    if (this.opts.resumeSessionId) {
      argv.push("--resume", this.opts.resumeSessionId);
    }

    if (this.opts.compact) {
      argv.push("--compact");
    }

    const env = { ...process.env, ...this.opts.env };
    delete env.CLAUDECODE;
    env.CI = "true";
    // Strip node_modules/.bin from PATH to avoid picking up local
    // @anthropic-ai/claude-code binary which may be an incompatible version
    if (env.PATH) {
      env.PATH = env.PATH.split(":").filter((p) => !p.includes("node_modules/.bin")).join(":");
    }

    log.info(`claude-process: spawning args=${argv.filter(a => a !== "").join(" ")}`);

    const child = spawn(claudePath, argv, {
      env,
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.alive = true;

    child.stdout!.on("data", (chunk: Buffer) => {
      this.lineBuf += chunk.toString();
      const lines = this.lineBuf.split("\n");
      this.lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        this.processLine(line);
      }
    });

    this.stderrBuf = [];
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) {
          log.warn(`claude-process: [stderr] ${line.trim()}`);
          this.stderrBuf.push(line.trim());
          // Keep only last 20 lines
          if (this.stderrBuf.length > 20) this.stderrBuf.shift();
        }
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      log.error(`claude-process: spawn error: ${err.message}`);
      this.alive = false;
      this.child = null;
      this.clearTurnTimeout();
      if (this.turnReject) {
        this.turnReject(new Error(`Claude process error: ${err.message}`));
        this.turnResolve = null;
        this.turnReject = null;
      }
    });

    child.on("close", (code) => {
      const stderrTail = this.stderrBuf.join("\n");
      log.warn(`claude-process: process exited code=${code}`);
      if (stderrTail) {
        log.error(`claude-process: stderr output:\n${stderrTail}`);
      }
      this.alive = false;
      this.child = null;
      this.clearTurnTimeout();
      if (this.turnReject) {
        const errDetail = stderrTail ? `\nstderr: ${stderrTail}` : "";
        this.turnReject(new Error(`Claude process exited unexpectedly (code ${code})${errDetail}`));
        this.turnResolve = null;
        this.turnReject = null;
      }
    });
  }

  sendMessage(
    text: string,
    onText?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<SendMessageResult> {
    const log = this.opts.logger;

    if (!this.child || !this.alive) {
      return Promise.reject(new Error("Claude process is not running"));
    }

    if (this.turnResolve) {
      return Promise.reject(new Error("Another message is already in-flight"));
    }

    // Clear any leftover signal listener from a previously aborted turn
    // (prevents the old task's signal from aborting this new turn)
    this.clearSignalListener();

    this.turnProseText = "";
    this.turnOnText = onText ?? null;
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    this.turnCacheRead = 0;
    this.turnCacheCreation = 0;
    this.turnCostUsd = undefined;
    this.turnNumTurns = undefined;
    this.turnDurationMs = undefined;
    this.turnContextTokens = 0;
    this.turnContextWindow = undefined;
    this.turnMaxOutputTokens = undefined;
    this.turnRateLimits.clear();

    // Attach signal listener for this turn
    if (signal) {
      this.turnSignalListener = () => this.abortTurn();
      signal.addEventListener("abort", this.turnSignalListener, { once: true });
      this.turnSignal = signal;
    }

    return new Promise<SendMessageResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;

      this.turnTimeout = setTimeout(() => {
        log.error(
          `claude-process: turn timeout after ${TURN_TIMEOUT_MS / 1000}s ` +
          `proseLen=${this.turnProseText.length}`,
        );
        this.completeTurn();
      }, TURN_TIMEOUT_MS);

      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      });

      log.info(`claude-process: sending message (${text.length} chars)`);

      this.child!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          log.error(`claude-process: stdin write error: ${err.message}`);
          this.clearTurnTimeout();
          this.clearSignalListener();
          this.turnResolve = null;
          this.turnReject = null;
          reject(new Error(`Failed to write to Claude stdin: ${err.message}`));
        }
      });
    });
  }

  /** Check if a turn is currently in progress. */
  isBusy(): boolean {
    return this.turnResolve !== null;
  }

  /** Abort the current in-flight turn without killing the process. */
  abortTurn(): void {
    if (!this.turnReject) return;
    this.staleResults++;
    this.ensureStaleDrainTimer();
    this.clearTurnTimeout();
    this.clearSignalListener();
    const reject = this.turnReject;
    this.turnResolve = null;
    this.turnReject = null;
    this.turnOnText = null;
    reject(new Error("Turn aborted by user"));
  }

  private clearTurnTimeout(): void {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }
  }

  private completeTurn(): void {
    this.clearTurnTimeout();
    this.clearSignalListener();

    // Persist rate limit snapshots
    for (const [type, rl] of this.turnRateLimits) {
      this.rateLimits.set(type, { ...rl });
      if (type === "five_hour") {
        const newResetsAt = rl.resetsAt ?? 0;
        if (newResetsAt !== this.windowResetsAt) {
          this.windowResetsAt = newResetsAt;
          this.windowInputTokens = 0;
          this.windowOutputTokens = 0;
          this.windowCostUsd = 0;
          this.windowTurns = 0;
        }
      }
    }
    // Accumulate window usage
    this.windowInputTokens += this.turnInputTokens + this.turnCacheRead + this.turnCacheCreation;
    this.windowOutputTokens += this.turnOutputTokens;
    if (this.turnCostUsd !== undefined) this.windowCostUsd += this.turnCostUsd;
    this.windowTurns += this.turnNumTurns ?? 1;

    // Persist context snapshot
    if (this.turnContextTokens > 0) {
      this.lastContext = {
        contextTokens: this.turnContextTokens,
        contextWindow: this.turnContextWindow,
        maxOutputTokens: this.turnMaxOutputTokens,
      };
    }

    if (this.turnResolve) {
      const resolve = this.turnResolve;
      this.turnResolve = null;
      this.turnReject = null;
      this.turnOnText = null;
      resolve({
        text: this.turnProseText,
        sessionId: this.sessionId,
        durationMs: this.turnDurationMs,
        numTurns: this.turnNumTurns,
      });
    }
  }

  private clearSignalListener(): void {
    if (this.turnSignal && this.turnSignalListener) {
      this.turnSignal.removeEventListener("abort", this.turnSignalListener);
    }
    this.turnSignal = null;
    this.turnSignalListener = null;
  }

  private clearStaleDrainTimer(): void {
    if (this.staleDrainTimer) {
      clearTimeout(this.staleDrainTimer);
      this.staleDrainTimer = null;
    }
  }

  private ensureStaleDrainTimer(): void {
    if (this.staleDrainTimer) return;

    const log = this.opts.logger;
    this.staleDrainTimer = setTimeout(() => {
      this.staleDrainTimer = null;
      if (this.staleResults <= 0) return;
      log.warn(
        `claude-process: stale turn drain timeout (${STALE_DRAIN_TIMEOUT_MS}ms), restarting process`,
      );
      this.staleResults = 0;
      void this.restart();
    }, STALE_DRAIN_TIMEOUT_MS);
  }

  private processLine(line: string): void {
    if (!line.trim()) return;

    const log = this.opts.logger;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.warn(`claude-process: unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    const eventType = String(event.type ?? "unknown");

    if (eventType === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
        log.info(`claude-process: session init sid=${this.sessionId.slice(0, 12)}`);
      }
      return;
    }

    if (eventType === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info) {
        const rlType = typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown";
        const rl: RateLimitInfo = {
          status: String(info.status ?? "unknown"),
          resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
          rateLimitType: rlType,
          overageStatus: typeof info.overageStatus === "string" ? info.overageStatus : undefined,
          overageResetsAt: typeof info.overageResetsAt === "number" ? info.overageResetsAt : undefined,
          isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
          utilization: typeof info.utilization === "number" ? info.utilization : undefined,
        };
        this.turnRateLimits.set(rlType, rl);
        if (rl.status !== "allowed") {
          log.warn(`claude-process: rate limit ${rlType} status=${rl.status} info=${JSON.stringify(info)}`);
        }
      }
      return;
    }

    // While draining stale results from an aborted turn, skip stream events
    if (this.staleResults > 0) {
      if (eventType === "stream_event" || eventType === "assistant" || eventType === "user") {
        return;
      }
      if (eventType === "result") {
        // Still track session ID and cost from the aborted turn
        if (typeof event.session_id === "string") {
          this.sessionId = event.session_id as string;
        }
        if (typeof event.total_cost_usd === "number") {
          this.totalCostUsd += event.total_cost_usd as number;
        }
        this.staleResults--;
        if (this.staleResults <= 0) {
          this.staleResults = 0;
          this.clearStaleDrainTimer();
        }
        log.info(`claude-process: discarded stale result (remaining=${this.staleResults})`);
        return;
      }
    }

    // Streaming text delta — Claude's prose (only thing we send to chat)
    if (eventType === "stream_event") {
      const inner = event.event as Record<string, unknown> | undefined;
      if (inner?.type === "content_block_delta") {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          const text = delta.text as string;
          this.turnProseText += text;
          this.turnOnText?.(text);
        }
      }
      // message_start carries input token counts
      if (inner?.type === "message_start") {
        const msgUsage = (inner.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        if (msgUsage) {
          if (msgUsage.input_tokens) this.turnInputTokens += msgUsage.input_tokens;
          if (msgUsage.cache_read_input_tokens) this.turnCacheRead += msgUsage.cache_read_input_tokens;
          if (msgUsage.cache_creation_input_tokens) this.turnCacheCreation += msgUsage.cache_creation_input_tokens;
          // Track latest input as context size (last message_start = most recent context)
          const totalInput = (msgUsage.input_tokens ?? 0) + (msgUsage.cache_read_input_tokens ?? 0) + (msgUsage.cache_creation_input_tokens ?? 0);
          if (totalInput > 0) this.turnContextTokens = totalInput;
        }
      }
      // message_delta carries output token counts
      if (inner?.type === "message_delta") {
        const deltaUsage = (inner as Record<string, unknown>).usage as Record<string, number> | undefined;
        if (deltaUsage?.output_tokens) this.turnOutputTokens += deltaUsage.output_tokens;
      }
      return;
    }

    // Silently skip tool calls and tool results (prose-only strategy)
    if (eventType === "assistant" || eventType === "user") {
      return;
    }

    // Result event — turn is complete
    if (eventType === "result") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
      }

      if (typeof event.total_cost_usd === "number") {
        this.totalCostUsd += event.total_cost_usd as number;
        this.turnCostUsd = event.total_cost_usd as number;
      }
      if (typeof event.num_turns === "number") {
        this.turnNumTurns = event.num_turns as number;
      }
      if (typeof event.duration_ms === "number") {
        this.turnDurationMs = event.duration_ms as number;
      }

      // Extract contextWindow/maxOutputTokens from modelUsage
      const modelUsage = event.modelUsage as Record<string, Record<string, unknown>> | undefined;
      if (modelUsage) {
        for (const [modelId, info] of Object.entries(modelUsage)) {
          // Only use the largest contextWindow (primary model, not sub-agent models like haiku)
          const cw = typeof info.contextWindow === "number" ? info.contextWindow : 0;
          if (cw > (this.turnContextWindow ?? 0)) {
            this.turnContextWindow = cw;
            this.resolvedModel = modelId;
          }
          if (typeof info.maxOutputTokens === "number") this.turnMaxOutputTokens = info.maxOutputTokens;
        }
      }

      const costUsd = typeof event.total_cost_usd === "number"
        ? (event.total_cost_usd as number).toFixed(4)
        : "?";
      const numTurns = event.num_turns ?? "?";
      const durationMs = event.duration_ms ?? "?";

      if (event.is_error || event.subtype === "error_during_execution") {
        const errors = event.errors as string[] | undefined;
        const errorMsg = errors?.join("; ") ?? String(event.result ?? "unknown error");
        log.error(`claude-process: turn error: ${errorMsg}`);

        if (!this.turnProseText.trim()) {
          log.warn("claude-process: error with no prose output, rejecting");
          this.clearTurnTimeout();
          if (this.turnReject) {
            const reject = this.turnReject;
            this.turnResolve = null;
            this.turnReject = null;
            this.turnOnText = null;
            reject(new Error(`Claude turn error: ${errorMsg}`));
          }
          return;
        }
      }

      log.info(
        `claude-process: turn complete sid=${this.sessionId.slice(0, 12)} ` +
        `proseLen=${this.turnProseText.length} ` +
        `turns=${numTurns} cost=$${costUsd} dur=${durationMs}ms`,
      );

      this.completeTurn();
      return;
    }

    log.warn(`claude-process: unhandled event type="${eventType}" subtype="${event.subtype ?? ""}"`);
  }

  async restart(): Promise<void> {
    this.opts.logger.info("claude-process: restarting...");
    await this.stop();
    this.staleResults = 0;
    this.clearStaleDrainTimer();
    this.start();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve();
        return;
      }

      const child = this.child;
      this.child = null;
      this.alive = false;

      this.clearTurnTimeout();
      this.clearStaleDrainTimer();
      if (this.turnReject) {
        this.turnReject(new Error("Claude process stopped"));
        this.turnResolve = null;
        this.turnReject = null;
      }

      child.on("close", () => resolve());
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 5000).unref();
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  getSessionId(): string {
    return this.sessionId || this.opts.resumeSessionId || "";
  }

  getTotalCost(): number {
    return this.totalCostUsd;
  }

  getCwd(): string | undefined {
    return this.opts.cwd;
  }

  getModel(): string | undefined {
    return this.resolvedModel ?? this.opts.model;
  }

  getRateLimits(): Map<string, RateLimitInfo> {
    return this.rateLimits;
  }

  getContext(): ContextUsage | undefined {
    return this.lastContext;
  }

  getWindowUsage(): WindowUsage | undefined {
    if (this.windowResetsAt === 0 && this.windowTurns === 0) return undefined;
    return {
      inputTokens: this.windowInputTokens,
      outputTokens: this.windowOutputTokens,
      costUsd: this.windowCostUsd,
      turns: this.windowTurns,
      resetsAt: this.windowResetsAt,
    };
  }

}
