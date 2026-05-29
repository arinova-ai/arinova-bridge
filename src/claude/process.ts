import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "../util/logger.js";
import { getErrorMessage } from "../util/errors.js";
import { UsageTracker } from "./usage-tracker.js";
import type { ContextUsage, RateLimitInfo, WindowUsage } from "./usage-tracker.js";
import {
  captureToolResultsFromEvent,
  captureToolUsesFromEvent,
  type PendingToolCall,
  type ToolCallReport,
} from "./tool-call-reporting.js";

export type { ContextUsage, RateLimitInfo, WindowUsage } from "./usage-tracker.js";
export type { ToolCallReport } from "./tool-call-reporting.js";

/**
 * Abstraction over `child_process.spawn` so callers can inject a test double.
 */
export interface ProcessSpawner {
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
}

const defaultSpawner: ProcessSpawner = { spawn: nodeSpawn };

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

export type SendMessageResult = {
  text: string;
  sessionId: string;
  durationMs?: number;
  numTurns?: number;
};

const DEFAULT_CLAUDE_PATH = "claude";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const STALE_DRAIN_TIMEOUT_MS = 300000;

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
  private stderrBuf: string[] = [];

  private readonly usage = new UsageTracker();

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
  private readonly spawner: ProcessSpawner;

  /** Map from event type to handler. Populated once in the constructor. */
  private readonly eventHandlers: Map<string, (event: Record<string, unknown>) => void>;

  /**
   * Compatibility getter so that tests setting `(process as any).turnContextTokens`
   * still work after the field moved into UsageTracker.
   */
  private get turnContextTokens(): number {
    return this.usage.turnContextTokens;
  }
  private set turnContextTokens(v: number) {
    this.usage.turnContextTokens = v;
  }

  constructor(opts: ClaudeProcessOptions, spawner?: ProcessSpawner) {
    this.opts = opts;
    this.spawner = spawner ?? defaultSpawner;
    this.logTag = opts.agentName ? `claude-process[${opts.agentName}]` : "claude-process";

    this.eventHandlers = new Map<string, (event: Record<string, unknown>) => void>([
      ["system", (e) => this.handleSystem(e)],
      ["rate_limit_event", (e) => this.handleRateLimitEvent(e)],
      ["stream_event", (e) => this.handleStreamEvent(e)],
      ["assistant", (e) => this.handleAssistant(e)],
      ["user", (e) => this.handleUser(e)],
      ["result", (e) => this.handleResult(e)],
    ]);
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
      "-p",
      "",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
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
      env.PATH = env.PATH.split(":")
        .filter((p) => !p.includes("node_modules/.bin"))
        .join(":");
    }

    // Redact the long --append-system-prompt value from log output
    const redactedArgs = argv.filter((a) => a !== "");
    const sysIdx = redactedArgs.indexOf("--append-system-prompt");
    if (sysIdx !== -1 && sysIdx + 1 < redactedArgs.length) {
      redactedArgs[sysIdx + 1] = "[...]";
    }
    log.info(`${this.logTag}: spawning args=${redactedArgs.join(" ")}`);

    const child = this.spawner.spawn(claudePath, argv, {
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
        this.opts.logger.info(`${this.logTag}: process exited while draining stale results, restarting`);
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
    this.usage.resetTurn();
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
          `${this.logTag}: turn timeout after ${TURN_TIMEOUT_MS / 1000}s ` + `proseLen=${this.turnProseText.length}`,
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

    this.usage.commitTurn();

    if (this.turnResolve) {
      const resolve = this.turnResolve;
      this.turnResolve = null;
      this.turnReject = null;
      this.turnOnText = null;
      resolve({
        text: this.turnProseText,
        sessionId: this.sessionId,
        durationMs: this.usage.turnDurationMs,
        numTurns: this.usage.turnNumTurns,
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
      log.warn(`${this.logTag}: stale turn drain timeout (${STALE_DRAIN_TIMEOUT_MS}ms), restarting process`);
      this.scheduleRestart();
    }, STALE_DRAIN_TIMEOUT_MS);
  }

  private scheduleRestart(): Promise<void> {
    this.clearStaleDrainTimer();
    if (this.restartPromise) return this.restartPromise;

    this.restartPromise = this.restart()
      .catch((err) => {
        this.opts.logger.error(`${this.logTag}: restart failed: ${getErrorMessage(err)}`);
        throw err;
      })
      .finally(() => {
        this.restartPromise = null;
      });

    return this.restartPromise;
  }

  // ---------------------------------------------------------------------------
  // processLine: JSON parse + event handler dispatch (R11)
  // ---------------------------------------------------------------------------

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

    // While draining stale results from an aborted turn, skip stream events
    if (this.staleResults > 0) {
      if (eventType === "stream_event" || eventType === "assistant" || eventType === "user") {
        return;
      }
      if (eventType === "result") {
        this.handleStaleResult(event);
        return;
      }
    }

    const handler = this.eventHandlers.get(eventType);
    if (handler) {
      handler(event);
    } else {
      log.warn(`${this.logTag}: unhandled event type="${eventType}" subtype="${event.subtype ?? ""}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers (one per event type, registered in eventHandlers map)
  // ---------------------------------------------------------------------------

  private handleSystem(event: Record<string, unknown>): void {
    if (event.subtype === "init") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
        this.opts.logger.info(`${this.logTag}: session init sid=${this.sessionId.slice(0, 12)}`);
      }
    }
    // Non-init system events (progress, etc.) carry no user-visible signal.
  }

  private handleRateLimitEvent(event: Record<string, unknown>): void {
    const info = event.rate_limit_info as Record<string, unknown> | undefined;
    if (info) {
      const rl = this.usage.recordRateLimit(info);
      if (rl.status !== "allowed") {
        this.opts.logger.warn(
          `${this.logTag}: rate limit ${rl.rateLimitType ?? "unknown"} status=${rl.status} info=${JSON.stringify(info)}`,
        );
      }
    }
  }

  private handleStreamEvent(event: Record<string, unknown>): void {
    const inner = event.event as Record<string, unknown> | undefined;

    // Streaming text delta — Claude's prose (only thing we send to chat)
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
        this.usage.recordMessageStart(msgUsage);
      }
    }
    // message_delta carries output token counts
    if (inner?.type === "message_delta") {
      const deltaUsage = (inner as Record<string, unknown>).usage as Record<string, number> | undefined;
      if (deltaUsage?.output_tokens) {
        this.usage.recordMessageDelta(deltaUsage);
      }
    }
  }

  /** assistant event: may contain tool_use blocks — record tool call start. */
  private handleAssistant(event: Record<string, unknown>): void {
    this.captureToolUses(event);
  }

  /** user event: may contain tool_result blocks — finalise + report each call. */
  private handleUser(event: Record<string, unknown>): void {
    this.captureToolResults(event);
  }

  private handleResult(event: Record<string, unknown>): void {
    const log = this.opts.logger;

    if (typeof event.session_id === "string") {
      this.sessionId = event.session_id as string;
    }

    this.usage.recordResult(event, this.opts.model);

    const costUsd = typeof event.total_cost_usd === "number" ? (event.total_cost_usd as number).toFixed(4) : "?";
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
  }

  /** Handle a result event that arrived after the turn was aborted. */
  private handleStaleResult(event: Record<string, unknown>): void {
    // Still track session ID and cost from the aborted turn
    if (typeof event.session_id === "string") {
      this.sessionId = event.session_id as string;
    }
    this.usage.recordStaleCost(event);
    this.staleResults--;
    if (this.staleResults <= 0) {
      this.staleResults = 0;
      this.clearStaleDrainTimer();
    }
    this.opts.logger.info(`${this.logTag}: discarded stale result (remaining=${this.staleResults})`);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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
    const captured = captureToolUsesFromEvent(event, this.turnToolCallSeq);
    this.turnToolCallSeq = captured.nextSeqOrder;
    for (const [id, pending] of captured.pending) {
      this.pendingToolCalls.set(id, pending);
    }
  }

  private captureToolResults(event: Record<string, unknown>): void {
    const reporter = this.opts.reportToolCall;
    const captured = captureToolResultsFromEvent({
      event,
      pendingToolCalls: this.pendingToolCalls,
      sessionId: this.sessionId,
      turnId: this.turnId ?? "",
      messageId: this.turnMessageId,
    });
    for (const useId of captured.completedIds) {
      this.pendingToolCalls.delete(useId);
    }
    for (const report of captured.reports) {
      if (reporter) {
        Promise.resolve()
          .then(() => reporter(report))
          .catch((err) => {
            this.opts.logger.warn(`${this.logTag}: reportToolCall failed: ${getErrorMessage(err)}`);
          });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  isAlive(): boolean {
    return this.alive;
  }

  getSessionId(): string {
    return this.sessionId || this.opts.resumeSessionId || "";
  }

  getTotalCost(): number {
    return this.usage.totalCostUsd;
  }

  getCwd(): string | undefined {
    return this.opts.cwd;
  }

  getModel(): string | undefined {
    return this.usage.resolvedModel ?? this.opts.model;
  }

  getRateLimits(): Map<string, RateLimitInfo> {
    return this.usage.rateLimits;
  }

  getContext(): ContextUsage | undefined {
    return this.usage.lastContext;
  }

  getWindowUsage(): WindowUsage | undefined {
    return this.usage.getWindowUsage();
  }
}
