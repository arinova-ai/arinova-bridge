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

/** Known context window sizes (tokens) per model. Used as fallback when CLI doesn't report contextWindow. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-5-20250514": 1_000_000,
  "claude-opus-4-20250514": 200_000,
};

/**
 * Find the modelUsage entry that matches opts.model. opts.model may be an
 * alias ("opus") or a full/dated id ("claude-opus-4-5-20251022"), while
 * modelUsage keys are usually full ids. Tries exact match first, then a
 * bidirectional substring match so "opus" matches "claude-opus-4-5".
 */
export function matchModelUsageEntry(
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
 * Tracks cumulative, per-window, and per-turn usage metrics (tokens, cost,
 * rate limits, context) so that ClaudeProcess can delegate all accounting.
 */
export class UsageTracker {
  totalCostUsd = 0;

  // Latest snapshot (persisted across turns for /usage)
  rateLimits = new Map<string, RateLimitInfo>();
  lastContext: ContextUsage | undefined;
  resolvedModel: string | undefined;

  // 5H window usage tracking
  private windowResetsAt = 0;
  private windowInputTokens = 0;
  private windowOutputTokens = 0;
  private windowCostUsd = 0;
  private windowTurns = 0;

  // Per-turn usage accumulators
  turnInputTokens = 0;
  turnOutputTokens = 0;
  turnCacheRead = 0;
  turnCacheCreation = 0;
  turnCostUsd: number | undefined;
  turnNumTurns: number | undefined;
  turnDurationMs: number | undefined;
  turnContextTokens = 0;
  turnContextWindow: number | undefined;
  turnMaxOutputTokens: number | undefined;
  turnRateLimits = new Map<string, RateLimitInfo>();

  /** Reset per-turn accumulators at the start of a new turn. */
  resetTurn(): void {
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
  }

  /** Persist turn-level snapshots into cumulative/window-level state. */
  commitTurn(): void {
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
        contextWindow:
          this.turnContextWindow ?? (this.resolvedModel ? MODEL_CONTEXT_WINDOWS[this.resolvedModel] : undefined),
        maxOutputTokens: this.turnMaxOutputTokens,
      };
    }
  }

  /** Record a rate limit event. Returns the parsed info for logging. */
  recordRateLimit(info: Record<string, unknown>): RateLimitInfo {
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
    return rl;
  }

  /** Record token counts from a message_start event. */
  recordMessageStart(msgUsage: Record<string, number>): void {
    if (msgUsage.input_tokens) this.turnInputTokens += msgUsage.input_tokens;
    if (msgUsage.cache_read_input_tokens) this.turnCacheRead += msgUsage.cache_read_input_tokens;
    if (msgUsage.cache_creation_input_tokens) this.turnCacheCreation += msgUsage.cache_creation_input_tokens;
    // Track latest input as context size (last message_start = most recent context)
    const totalInput =
      (msgUsage.input_tokens ?? 0) +
      (msgUsage.cache_read_input_tokens ?? 0) +
      (msgUsage.cache_creation_input_tokens ?? 0);
    if (totalInput > 0) this.turnContextTokens = totalInput;
  }

  /** Record output token counts from a message_delta event. */
  recordMessageDelta(deltaUsage: Record<string, number>): void {
    if (deltaUsage.output_tokens) this.turnOutputTokens += deltaUsage.output_tokens;
  }

  /** Record result-level fields (cost, turns, duration, model usage). */
  recordResult(event: Record<string, unknown>, configuredModel: string | undefined): void {
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

      if (configuredModel) {
        this.resolvedModel = configuredModel;
        const match = matchModelUsageEntry(modelUsage, configuredModel);
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
  }

  /** Record cost from a stale (aborted) result without updating turn accumulators. */
  recordStaleCost(event: Record<string, unknown>): void {
    if (typeof event.total_cost_usd === "number") {
      this.totalCostUsd += event.total_cost_usd as number;
    }
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
