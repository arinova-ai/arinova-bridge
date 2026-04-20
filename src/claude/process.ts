import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "../util/logger.js";

/**
 * A single tool call report, emitted immediately after each tool completes.
 * Mirrors `@arinova-ai/agent-sdk`'s `ToolCallReport` so ClaudeProcess does
 * not need to depend on the SDK directly; the caller wires the reporter to
 * `ArinovaAgent.reportToolCall()`.
 */
export interface ToolCallReport {
  sessionId: string;
  turnId: string;
  seqOrder: number;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  success: boolean;
  error?: string;
  /** UUID of the user message that triggered this turn (optional). */
  messageId?: string;
}

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
  agentName?: string;
  /**
   * Invoked once per tool call completion. Fired fire-and-forget from the
   * stream handler — errors are logged and swallowed so a failing reporter
   * cannot break the turn.
   */
  reportToolCall?: (report: ToolCallReport) => void | Promise<void>;
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

/** Known context window sizes (tokens) per model. Used as fallback when CLI doesn't report contextWindow. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-5-20250514": 1_000_000,
  "claude-opus-4-20250514": 200_000,
};

const DEFAULT_CLAUDE_PATH = "claude";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_DRAIN_TIMEOUT_MS = 300000;

interface PendingToolCall {
  toolName: string;
  input: Record<string, unknown>;
  startedAt: number;
  seqOrder: number;
}

/**
 * Find the modelUsage entry that matches opts.model. opts.model may be an
 * alias ("opus") or a full/dated id ("claude-opus-4-5-20251022"), while
 * modelUsage keys are usually full ids. Tries exact match first, then a
 * bidirectional substring match so "opus" matches "claude-opus-4-5".
 */
function matchModelUsageEntry(
  modelUsage: Record<string, Record<string, unknown>>,
  model: string,
): Record<string, unknown> | undefined {
  if (modelUsage[model]) return modelUsage[model];
  const needle = model.toLowerCase();
  for (const [key, info] of Object.entries(modelUsage)) {
    const hay = key.toLowerCase();
    if (hay === needle || hay.includes(needle) || needle.includes(hay)) return info;
  }
  return undefined;
}

/**
 * Flatten a tool_result `content` value into a string for error reporting.
 * Claude emits either a plain string or an array of `{type:"text",text}` blocks.
 */
function toolResultContentToString(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
        }
        return typeof block === "string" ? block : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

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
  /** UUID generated at sendMessage() time; shared across tool calls in the turn. */
  private turnId: string | null = null;
  /** UUID of the user message that triggered the current turn (propagated from TaskContext.userMessageId). */
  private turnMessageId: string | undefined;
  /** In-flight tool calls keyed by tool_use id, awaiting their tool_result block. */
  private pendingToolCalls = new Map<string, PendingToolCall>();
  /** 0-based counter assigned to tool calls in the order they are started. */
  private turnToolCallSeq = 0;
  /** Number of aborted turn results still expected from the process. */
  private staleResults = 0;
  private staleDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private restartPromise: Promise<void> | null = null;
  /** Signal and listener for the current turn (cleared on abort/complete). */
  private turnSignal: AbortSignal | null = null;
  private turnSignalListener: (() => void) | null = null;

  private readonly logTag: string;

  constructor(opts: ClaudeProcessOptions) {
    this.opts = opts;
    this.logTag = opts.agentName ? `claude-process[${opts.agentName}]` : "claude-process";
  }

  /**
   * Update the tool-call reporter on an already-live process. Used so callers
   * can refresh the reporter on each turn (e.g. after a resume that recreated
   * the session without a reporter).
   */
  setReportToolCall(reporter: ClaudeProcessOptions["reportToolCall"]): void {
    this.opts.reportToolCall = reporter;
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
    // Per-session agent name so A2A --source fallback is correct even when
    // multiple agents share the same provider instance.
    if (this.opts.agentName) env.ARINOVA_AGENT_NAME = this.opts.agentName;
    // Strip node_modules/.bin from PATH to avoid picking up local
    // @anthropic-ai/claude-code binary which may be an incompatible version
    if (env.PATH) {
      env.PATH = env.PATH.split(":").filter((p) => !p.includes("node_modules/.bin")).join(":");
    }

    // Redact the long --append-system-prompt value from log output
    const redactedArgs = argv.filter(a => a !== "");
    const sysIdx = redactedArgs.indexOf("--append-system-prompt");
    if (sysIdx !== -1 && sysIdx + 1 < redactedArgs.length) {
      redactedArgs[sysIdx + 1] = "[...]";
    }
    log.info(`${this.logTag}: spawning args=${redactedArgs.join(" ")}`);

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
          log.warn(`${this.logTag}: [stderr] ${line.trim()}`);
          this.stderrBuf.push(line.trim());
          // Keep only last 20 lines
          if (this.stderrBuf.length > 20) this.stderrBuf.shift();
        }
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      log.error(`${this.logTag}: spawn error: ${err.message}`);
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
      log.warn(`${this.logTag}: process exited code=${code}`);
      if (stderrTail) {
        log.error(`${this.logTag}: stderr output:\n${stderrTail}`);
      }
      this.alive = false;
      this.child = null;
      this.clearTurnTimeout();
      if (this.staleResults > 0) {
        this.opts.logger.info(
          `${this.logTag}: process exited while draining stale results, restarting`,
        );
        this.scheduleRestart();
        return;
      }
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
    messageId?: string,
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
    this.turnId = randomUUID();
    this.turnMessageId = messageId;
    this.pendingToolCalls.clear();
    this.turnToolCallSeq = 0;

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
          `${this.logTag}: turn timeout after ${TURN_TIMEOUT_MS / 1000}s ` +
          `proseLen=${this.turnProseText.length}`,
        );
        this.completeTurn();
      }, TURN_TIMEOUT_MS);

      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      });

      log.info(`${this.logTag}: sending message (${text.length} chars)`);

      this.child!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          log.error(`${this.logTag}: stdin write error: ${err.message}`);
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

    // Send SIGINT to the Claude CLI process so it actually stops the current
    // turn (e.g. sub-agent tasks, tool execution).  Without this the process
    // keeps running and the bridge waits for a stale result that may never
    // arrive promptly, causing the "stuck after abort" symptom.
    if (this.child?.pid && !this.child.killed) {
      this.child.kill("SIGINT");
      this.alive = false;
    }

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
        contextWindow: this.turnContextWindow
          ?? (this.resolvedModel ? MODEL_CONTEXT_WINDOWS[this.resolvedModel] : undefined),
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
        `${this.logTag}: stale turn drain timeout (${STALE_DRAIN_TIMEOUT_MS}ms), restarting process`,
      );
      this.scheduleRestart();
    }, STALE_DRAIN_TIMEOUT_MS);
  }

  private scheduleRestart(): Promise<void> {
    this.clearStaleDrainTimer();
    if (this.restartPromise) return this.restartPromise;

    this.restartPromise = this.restart()
      .catch((err) => {
        this.opts.logger.error(
          `${this.logTag}: restart failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      })
      .finally(() => {
        this.restartPromise = null;
      });

    return this.restartPromise;
  }

  private processLine(line: string): void {
    if (!line.trim()) return;

    const log = this.opts.logger;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.warn(`${this.logTag}: unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    const eventType = String(event.type ?? "unknown");

    if (eventType === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
        log.info(`${this.logTag}: session init sid=${this.sessionId.slice(0, 12)}`);
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
          log.warn(`${this.logTag}: rate limit ${rlType} status=${rl.status} info=${JSON.stringify(info)}`);
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
        log.info(`${this.logTag}: discarded stale result (remaining=${this.staleResults})`);
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

    // assistant event: may contain tool_use blocks — record tool call start.
    if (eventType === "assistant") {
      this.captureToolUses(event);
      return;
    }

    // user event: may contain tool_result blocks — finalise + report each call.
    if (eventType === "user") {
      this.captureToolResults(event);
      return;
    }

    // System progress events carry no user-visible signal.
    if (eventType === "system") {
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

      // Resolve the primary turn model for hud_update.
      // opts.model is the user's explicit selection — trust it. modelUsage is
      // only used to pull contextWindow (max across models) and the matching
      // entry's maxOutputTokens. Falling back to "model with most outputTokens"
      // is unreliable because outputTokens is a session-cumulative value, so a
      // Haiku sub-agent used for compact/summarize can eventually outrank the
      // primary Opus/Sonnet across multiple turns.
      const modelUsage = event.modelUsage as Record<string, Record<string, unknown>> | undefined;
      if (modelUsage) {
        for (const info of Object.values(modelUsage)) {
          const cw = typeof info.contextWindow === "number" ? info.contextWindow : 0;
          if (cw > (this.turnContextWindow ?? 0)) this.turnContextWindow = cw;
        }

        if (this.opts.model) {
          this.resolvedModel = this.opts.model;
          const match = matchModelUsageEntry(modelUsage, this.opts.model);
          if (match && typeof match.maxOutputTokens === "number") {
            this.turnMaxOutputTokens = match.maxOutputTokens;
          }
        } else {
          let bestModelId: string | undefined;
          let bestOutputTokens = -1;
          let bestMaxOutputTokens: number | undefined;
          for (const [modelId, info] of Object.entries(modelUsage)) {
            if (typeof info.outputTokens === "number" && info.outputTokens > bestOutputTokens) {
              bestOutputTokens = info.outputTokens;
              bestModelId = modelId;
              bestMaxOutputTokens = typeof info.maxOutputTokens === "number" ? info.maxOutputTokens : undefined;
            }
          }
          if (bestModelId) {
            this.resolvedModel = bestModelId;
            if (bestMaxOutputTokens !== undefined) this.turnMaxOutputTokens = bestMaxOutputTokens;
          }
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
        log.error(`${this.logTag}: turn error: ${errorMsg}`);

        if (!this.turnProseText.trim()) {
          log.warn(`${this.logTag}: error with no prose output, rejecting`);
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
        `${this.logTag}: turn complete sid=${this.sessionId.slice(0, 12)} ` +
        `proseLen=${this.turnProseText.length} ` +
        `turns=${numTurns} cost=$${costUsd} dur=${durationMs}ms`,
      );

      this.completeTurn();
      return;
    }

    log.warn(`${this.logTag}: unhandled event type="${eventType}" subtype="${event.subtype ?? ""}"`);
  }

  async restart(): Promise<void> {
    this.opts.logger.info(`${this.logTag}: restarting...`);
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

  private captureToolUses(event: Record<string, unknown>): void {
    if (!this.turnId) return;
    const message = event.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type !== "tool_use") continue;
      const id = typeof block.id === "string" ? block.id : "";
      if (!id) continue;
      const toolName = typeof block.name === "string" ? block.name : "";
      const input = (block.input && typeof block.input === "object"
        ? (block.input as Record<string, unknown>)
        : {});
      this.pendingToolCalls.set(id, {
        toolName,
        input,
        startedAt: Date.now(),
        seqOrder: this.turnToolCallSeq++,
      });
    }
  }

  private captureToolResults(event: Record<string, unknown>): void {
    const reporter = this.opts.reportToolCall;
    const message = event.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      if (block.type !== "tool_result") continue;
      const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!useId) continue;
      const pending = this.pendingToolCalls.get(useId);
      if (!pending) continue;
      this.pendingToolCalls.delete(useId);

      const isError = block.is_error === true;
      const rawOutput = (block as { content?: unknown }).content;
      const report: ToolCallReport = {
        sessionId: this.sessionId,
        turnId: this.turnId ?? "",
        seqOrder: pending.seqOrder,
        toolName: pending.toolName,
        input: pending.input,
        durationMs: Date.now() - pending.startedAt,
        success: !isError,
      };
      if (this.turnMessageId) report.messageId = this.turnMessageId;
      if (isError) {
        report.error = toolResultContentToString(rawOutput);
      } else if (rawOutput !== undefined) {
        report.output = rawOutput;
      }

      if (reporter) {
        Promise.resolve()
          .then(() => reporter(report))
          .catch((err) => {
            this.opts.logger.warn(
              `${this.logTag}: reportToolCall failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }
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
