import { describe, expect, it } from "vitest";
import { UsageTracker, matchModelUsageEntry } from "../../../src/claude/usage-tracker.js";

describe("UsageTracker", () => {
  it("records rate-limit snapshots into committed state", () => {
    const tracker = new UsageTracker();

    const rl = tracker.recordRateLimit({
      status: "blocked",
      resetsAt: 123,
      rateLimitType: "five_hour",
      overageStatus: "allowed",
      overageResetsAt: 456,
      isUsingOverage: true,
      utilization: 0.75,
    });
    tracker.commitTurn();

    expect(rl).toEqual({
      status: "blocked",
      resetsAt: 123,
      rateLimitType: "five_hour",
      overageStatus: "allowed",
      overageResetsAt: 456,
      isUsingOverage: true,
      utilization: 0.75,
    });
    expect(tracker.rateLimits.get("five_hour")).toEqual(rl);
    expect(tracker.getWindowUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      turns: 1,
      resetsAt: 123,
    });
  });

  it("records context using configured model fallback window and matched max output", () => {
    const tracker = new UsageTracker();

    tracker.recordMessageStart({
      input_tokens: 100,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    });
    tracker.recordResult(
      {
        modelUsage: {
          "claude-opus-4-6-20260501": {
            maxOutputTokens: 32000,
            outputTokens: 10,
          },
        },
      },
      "claude-opus-4-6",
    );
    tracker.commitTurn();

    expect(tracker.resolvedModel).toBe("claude-opus-4-6");
    expect(tracker.lastContext).toEqual({
      contextTokens: 115,
      contextWindow: 1_000_000,
      maxOutputTokens: 32000,
    });
  });

  it("resolves model from highest output usage when no model is configured", () => {
    const tracker = new UsageTracker();

    tracker.recordMessageStart({ input_tokens: 50 });
    tracker.recordResult(
      {
        modelUsage: {
          "claude-haiku-4-5": { outputTokens: 100, contextWindow: 200000, maxOutputTokens: 8000 },
          "claude-sonnet-4-6": { outputTokens: 250, contextWindow: 1000000, maxOutputTokens: 64000 },
        },
      },
      undefined,
    );
    tracker.commitTurn();

    expect(tracker.resolvedModel).toBe("claude-sonnet-4-6");
    expect(tracker.lastContext).toEqual({
      contextTokens: 50,
      contextWindow: 1_000_000,
      maxOutputTokens: 64000,
    });
  });

  it("records stale cost without changing window usage", () => {
    const tracker = new UsageTracker();

    tracker.recordStaleCost({ total_cost_usd: 0.42 });

    expect(tracker.totalCostUsd).toBe(0.42);
    expect(tracker.getWindowUsage()).toBeUndefined();
  });

  it("matches model usage by exact, alias, and reverse substring", () => {
    const usage = {
      "claude-opus-4-6-20260501": { maxOutputTokens: 32000 },
      sonnet: { maxOutputTokens: 16000 },
    };

    expect(matchModelUsageEntry(usage, "sonnet")).toEqual({ maxOutputTokens: 16000 });
    expect(matchModelUsageEntry(usage, "opus")).toEqual({ maxOutputTokens: 32000 });
    expect(matchModelUsageEntry(usage, "claude-sonnet-4-6")).toEqual({ maxOutputTokens: 16000 });
    expect(matchModelUsageEntry(usage, "haiku")).toBeUndefined();
  });
});
