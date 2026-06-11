import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ClaudePty } from "../pty/claude-pty.js";
import { ResponseTimeoutError } from "../pty/errors.js";
import { ClaudeState } from "../pty/types.js";
import type { TurnUsage, TurnToolCall } from "../pty/types.js";
import type { Logger } from "../util/logger.js";

const BRIDGE_CLAUDE_SETTINGS = path.join(homedir(), ".arinova-bridge", "claude-settings.json");
export type ToolCallReport = {
  sessionId: string;
  turnId: string;
  seqOrder: number;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  success: boolean;
  error?: string;
  messageId?: string;
};

export type RateLimitInfo = {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
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

// Pattern rules instead of an exact-id table: model strings arrive as
// aliases ("haiku"), full dated ids, or statusline display names
// ("Haiku 4.5") — an exact-match miss must NEVER fabricate a tiny
// window (the old `contextWindow: 100` fallback made needsCompact's
// threshold ~50 tokens, so every turn auto-compacted and the chat sat
// in "streaming" for the whole invisible compact turn).
const MODEL_CONTEXT_WINDOW_RULES: Array<{ match: RegExp; window: number }> = [
  { match: /fable/i, window: 1_000_000 },
  { match: /opus[ -]?4[.-][5-9]/i, window: 1_000_000 },
  { match: /sonnet[ -]?4[.-][5-9]/i, window: 1_000_000 },
  { match: /haiku/i, window: 200_000 },
  { match: /opus|sonnet/i, window: 200_000 },
];

// Conservative default for unknown models: compacting a bit early is
// harmless; a fabricated tiny window compacts on every turn.
const DEFAULT_CONTEXT_WINDOW = 200_000;

export function contextWindowFor(modelId: string): number {
  for (const rule of MODEL_CONTEXT_WINDOW_RULES) {
    if (rule.match.test(modelId)) return rule.window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Parse a duration string like "3d2h05m" or "2h30m" or "45m" to a future epoch (seconds). */
function durationToEpoch(dur: string): number {
  let secs = 0;
  const d = dur.match(/(\d+)\s*d/);
  const h = dur.match(/(\d+)\s*h/);
  const m = dur.match(/(\d+)\s*m/);
  if (d) secs += parseInt(d[1], 10) * 86400;
  if (h) secs += parseInt(h[1], 10) * 3600;
  if (m) secs += parseInt(m[1], 10) * 60;
  return Math.floor(Date.now() / 1000) + secs;
}

export type PtyProcessOptions = {
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
  reportToolCall?: (report: ToolCallReport) => void | Promise<void>;
};

export class PtyProcess {
  private pty: ClaudePty | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyError: Error | null = null;
  private opts: PtyProcessOptions;
  private logTag: string;

  private sessionId = "";
  private totalCostUsd = 0;
  private lastContext: ContextUsage | undefined;
  private lastUsage: TurnUsage | undefined;
  private alive = false;

  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((error: Error) => void) | null = null;
  private turnOnText: ((text: string) => void) | null = null;
  private turnId = "";
  private turnMessageId: string | undefined;
  private turnToolCallSeq = 0;
  private reporter: PtyProcessOptions["reportToolCall"] | undefined;

  constructor(opts: PtyProcessOptions) {
    this.opts = opts;
    this.logTag = opts.agentName ? `[pty:${opts.agentName}]` : "[pty]";
    this.reporter = opts.reportToolCall;
  }

  setReportToolCall(reporter: PtyProcessOptions["reportToolCall"]): void {
    this.reporter = reporter;
  }

  start(): void {
    const extraArgs: string[] = [];
    if (existsSync(BRIDGE_CLAUDE_SETTINGS)) extraArgs.push("--settings", BRIDGE_CLAUDE_SETTINGS);
    if (this.opts.mcpConfigPath) extraArgs.push("--mcp-config", this.opts.mcpConfigPath);
    if (this.opts.resumeSessionId) extraArgs.push("--resume", this.opts.resumeSessionId);
    if (this.opts.compact) extraArgs.push("--compact");

    const env: Record<string, string> = { ...this.opts.env };
    env.CI = "true";
    if (this.opts.agentName) env.ARINOVA_AGENT_NAME = this.opts.agentName;

    this.pty = new ClaudePty({
      claudePath: this.opts.claudePath ?? "claude",
      cwd: this.opts.cwd,
      model: this.opts.model,
      systemPrompt: this.opts.systemPrompt,
      permissionMode: "bypassPermissions",
      args: extraArgs,
      env,
      responseTimeoutMs: 10 * 60 * 1000,
      // Fresh sessions get a generated --session-id; resumed sessions
      // append to their existing `<resumeSessionId>.jsonl` (verified),
      // so both paths read the transcript — the screen-scrape fallback
      // would return TUI-rendered markdown (tables become box-drawing
      // graphics), which chat clients cannot render.
      sessionId: this.opts.resumeSessionId,
      passSessionIdArg: !this.opts.resumeSessionId,
    });

    this.alive = true;

    this.pty.on("content", (delta: string) => {
      this.turnOnText?.(delta);
    });

    // Tool reports come from the transcript (tool_use paired with its
    // tool_result): real input JSON, output, error state, and duration —
    // the screen-scraped `toolUse` event only knows a name and a
    // one-line summary.
    this.pty.on("toolCall", (call: TurnToolCall) => {
      if (!this.reporter) return;
      const report: ToolCallReport = {
        sessionId: this.sessionId,
        turnId: this.turnId,
        seqOrder: this.turnToolCallSeq++,
        toolName: call.toolName,
        input: (call.input && typeof call.input === "object"
          ? call.input
          : { value: call.input ?? null }) as Record<string, unknown>,
        output: call.output,
        durationMs: call.durationMs,
        success: !call.isError,
        error: call.isError
          ? (call.output ?? "tool error").slice(0, 500)
          : undefined,
        messageId: this.turnMessageId,
      };
      try { Promise.resolve(this.reporter(report)).catch(() => {}); } catch { /* ignore */ }
    });

    this.pty.on("exit", (code: number) => {
      this.alive = false;
      this.opts.logger.info(`${this.logTag}: process exited code=${code}`);
      if (this.turnReject) {
        const reject = this.turnReject;
        this.turnResolve = null;
        this.turnReject = null;
        this.turnOnText = null;
        reject(new Error(`Claude process exited unexpectedly (code=${code})`));
      }
    });

    this.pty.on("error", (err: Error) => {
      this.opts.logger.error(`${this.logTag}: error: ${err.message}`);
    });

    const pty = this.pty;
    this.readyPromise = pty.start().then(() => {
      this.opts.logger.info(`${this.logTag}: ready (IDLE)`);
      // Fresh sessions run under the --session-id we generated; resumed
      // ones keep the id they were resumed from.
      this.sessionId = this.opts.resumeSessionId ?? pty.sessionId;
    }).catch((err: Error) => {
      this.readyError = err;
      this.alive = false;
      this.opts.logger.error(`${this.logTag}: startup failed: ${err.message}`);
    });
  }

  async sendMessage(
    text: string,
    onText?: (text: string) => void,
    signal?: AbortSignal,
    messageId?: string,
  ): Promise<SendMessageResult> {
    if (!this.pty) throw new Error("PtyProcess not started");
    if (this.readyPromise) {
      await this.readyPromise;
      this.readyPromise = null;
    }
    if (this.readyError) throw this.readyError;
    if (!this.alive) throw new Error("Claude process exited unexpectedly");

    this.turnId = randomUUID();
    this.turnMessageId = messageId;
    this.turnToolCallSeq = 0;
    this.turnOnText = onText ?? null;

    if (signal?.aborted) throw new Error("Turn aborted by user");

    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => {
        this.abortTurn();
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      const result = await this.pty.send(text, { autoApprovePermissions: true });

      const usage = result.usage;
      this.lastUsage = usage;
      if (usage?.costUsd != null) {
        this.totalCostUsd += usage.costUsd;
      }
      if (usage?.contextPercent != null) {
        // Prefer the transcript-reported model (full id) over the
        // configured one (possibly an alias) for the window lookup.
        const modelId = usage.model ?? this.opts.model ?? "";
        const contextWindow = contextWindowFor(modelId);
        this.lastContext = {
          contextTokens: Math.round((usage.contextPercent / 100) * contextWindow),
          contextWindow,
        };
      }

      return {
        text: result.response,
        sessionId: this.sessionId,
        durationMs: result.durationMs,
        numTurns: 1,
      };
    } catch (err) {
      if (signal?.aborted) throw new Error("Turn aborted by user", { cause: err });
      if (err instanceof ResponseTimeoutError) {
        // The response timer only rejects the JS promise — the CLI is still
        // mid-turn, so every later send would fail with NOT_READY until it
        // finishes on its own. Interrupt it and wait for the prompt back.
        this.abortTurn();
        let recovered = await this.waitForIdle(5000);
        if (!recovered) {
          this.abortTurn();
          recovered = await this.waitForIdle(5000);
        }
        this.opts.logger.warn(
          `${this.logTag}: response timed out — interrupted turn, ${recovered ? "back to IDLE" : "still busy"}`,
        );
      }
      throw err;
    } finally {
      this.turnOnText = null;
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  abortTurn(): void {
    this.pty?.writeRaw("\x03");
  }

  /** Poll until the CLI prompt returns to IDLE. Resolves true once idle. */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.alive || !this.pty) return false;
      if (this.pty.state === ClaudeState.IDLE) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.pty?.state === ClaudeState.IDLE;
  }

  async stop(): Promise<void> {
    if (!this.pty) return;
    try {
      await this.pty.close(5000);
    } catch {
      this.pty.kill();
    }
    this.pty.dispose();
    this.pty = null;
    this.alive = false;
  }

  async restart(): Promise<void> {
    const prevSessionId = this.sessionId;
    await this.stop();
    if (prevSessionId) {
      this.opts.resumeSessionId = prevSessionId;
    }
    this.start();
  }

  isBusy(): boolean {
    if (!this.pty) return false;
    const s = this.pty.state;
    return s === ClaudeState.RESPONDING || s === ClaudeState.TOOL_USE;
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
    return this.opts.model;
  }

  getRateLimits(): Map<string, RateLimitInfo> {
    const map = new Map<string, RateLimitInfo>();
    if (this.lastUsage?.limit5hPercent != null) {
      map.set("five_hour", {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: this.lastUsage.limit5hPercent / 100,
        resetsAt: this.lastUsage.limit5hResetIn ? durationToEpoch(this.lastUsage.limit5hResetIn) : undefined,
      });
    }
    if (this.lastUsage?.limit7dPercent != null) {
      map.set("seven_day", {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: this.lastUsage.limit7dPercent / 100,
        resetsAt: this.lastUsage.limit7dResetIn ? durationToEpoch(this.lastUsage.limit7dResetIn) : undefined,
      });
    }
    return map;
  }

  getContext(): ContextUsage | undefined {
    return this.lastContext;
  }

  getWindowUsage(): WindowUsage | undefined {
    return undefined;
  }
}
