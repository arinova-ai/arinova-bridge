/**
 * Additional coverage tests for ClaudeProcess and UsageTracker.
 *
 * Targets uncovered statements (~160) to bring process.ts from ~64% to 80%+.
 * Uses the injectable ProcessSpawner interface to avoid mocking node:child_process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClaudeProcess, type ProcessSpawner } from "../../../src/claude/process.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** A minimal fake ChildProcess backed by EventEmitters for stdout/stderr. */
function createFakeChild(): ChildProcess & {
  _stdout: EventEmitter;
  _stderr: EventEmitter;
  _stdin: { write: ReturnType<typeof vi.fn> };
} {
  const child = new EventEmitter() as any;
  child._stdout = new EventEmitter();
  child._stderr = new EventEmitter();
  child._stdin = { write: vi.fn((_data: string, cb?: (err?: Error) => void) => { cb?.(); }) };
  child.stdout = child._stdout;
  child.stderr = child._stderr;
  child.stdin = child._stdin;
  child.pid = 12345;
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn((sig?: string) => {
    if (sig === "SIGTERM" || sig === "SIGKILL") {
      child.killed = true;
      // Simulate close event asynchronously
      setTimeout(() => child.emit("close", 0), 0);
    }
    if (sig === "SIGINT") {
      child.killed = true;
    }
    return true;
  });
  return child;
}

/** Create a ProcessSpawner that returns a pre-created fake child. */
function createMockSpawner(child: ReturnType<typeof createFakeChild>): ProcessSpawner {
  return { spawn: vi.fn((): ChildProcess => child as unknown as ChildProcess) };
}

/** Feed a JSON line to the child's stdout as if it came from the real process. */
function feedLine(child: ReturnType<typeof createFakeChild>, obj: Record<string, unknown>): void {
  child._stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

/** Feed raw text to the child's stdout. */
function feedRaw(child: ReturnType<typeof createFakeChild>, text: string): void {
  child._stdout.emit("data", Buffer.from(text));
}

/** Feed text to the child's stderr. */
function feedStderr(child: ReturnType<typeof createFakeChild>, text: string): void {
  child._stderr.emit("data", Buffer.from(text));
}

/** Prime a ClaudeProcess for processLine testing without a real turn promise. */
function primeTurn(proc: ClaudeProcess, turnId = "turn-test"): void {
  (proc as any).turnResolve = vi.fn();
  (proc as any).turnReject = vi.fn();
  (proc as any).turnId = turnId;
  (proc as any).pendingToolCalls = new Map();
  (proc as any).turnToolCallSeq = 0;
  (proc as any).sessionId = "sess-abc";
}

// ===========================================================================
// start() with ProcessSpawner
// ===========================================================================

describe("ClaudeProcess.start() with ProcessSpawner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("spawns the claude CLI with expected default args", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    expect(spawner.spawn).toHaveBeenCalledTimes(1);
    const args = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(proc.isAlive()).toBe(true);
  });

  it("passes model flag when opts.model is set", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, model: "claude-opus-4-6" }, spawner);
    proc.start();

    const args = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
  });

  it("passes --mcp-config when mcpConfigPath is set", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, mcpConfigPath: "/tmp/mcp.json" }, spawner);
    proc.start();

    const args = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
  });

  it("passes --append-system-prompt when systemPrompt is set", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, systemPrompt: "Be helpful." }, spawner);
    proc.start();

    const args = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Be helpful.");
  });

  it("passes --resume when resumeSessionId is set", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, resumeSessionId: "session-123" }, spawner);
    proc.start();

    const args = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
  });

  it("passes --compact when compact is true", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, compact: true }, spawner);
    proc.start();

    const args = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toContain("--compact");
  });

  it("does not double-start if already started", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    proc.start(); // second call should be a no-op

    expect(spawner.spawn).toHaveBeenCalledTimes(1);
  });

  it("strips node_modules/.bin from PATH", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/foo/node_modules/.bin:/usr/local/bin";

    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const env = (spawner.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env;
    expect(env.PATH).not.toContain("node_modules/.bin");
    expect(env.PATH).toContain("/usr/bin");

    process.env.PATH = originalPath;
  });
});

// ===========================================================================
// stdout / stderr / error / close handlers in start()
// ===========================================================================

describe("ClaudeProcess stdio handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes JSON lines from stdout", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedLine(child, { type: "system", subtype: "init", session_id: "sid-123456789012" });

    expect(proc.getSessionId()).toBe("sid-123456789012");
  });

  it("handles partial lines split across chunks", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    // Send first half
    feedRaw(child, '{"type":"system","subtype":"init","sess');
    // Send second half
    feedRaw(child, 'ion_id":"sid-split"}\n');

    expect(proc.getSessionId()).toBe("sid-split");
  });

  it("logs stderr lines and keeps only last 20", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    for (let i = 0; i < 25; i++) {
      feedStderr(child, `error line ${i}\n`);
    }

    const stderrBuf = (proc as any).stderrBuf as string[];
    expect(stderrBuf.length).toBeLessThanOrEqual(20);
    expect(stderrBuf[stderrBuf.length - 1]).toContain("error line 24");
  });

  it("handles spawn error — rejects pending turn and marks dead", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    // Set up pending turn
    const rejectFn = vi.fn();
    (proc as any).turnReject = rejectFn;
    (proc as any).turnResolve = vi.fn();

    child.emit("error", new Error("spawn ENOENT"));

    expect(proc.isAlive()).toBe(false);
    expect(rejectFn).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("spawn ENOENT"),
    }));
  });

  it("handles close event — rejects pending turn with exit code and stderr", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedStderr(child, "some error detail\n");

    const rejectFn = vi.fn();
    (proc as any).turnReject = rejectFn;
    (proc as any).turnResolve = vi.fn();

    child.emit("close", 1);

    expect(proc.isAlive()).toBe(false);
    expect(rejectFn).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("exited unexpectedly (code 1)"),
    }));
    expect(rejectFn).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("some error detail"),
    }));
  });

  it("close while draining stale results triggers restart instead of reject", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    (proc as any).staleResults = 1;
    const restartSpy = vi.spyOn(proc, "restart").mockResolvedValue();

    child.emit("close", 0);

    expect(restartSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// sendMessage()
// ===========================================================================

describe("ClaudeProcess.sendMessage()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("rejects when process is not running", async () => {
    const proc = new ClaudeProcess({ logger });
    await expect(proc.sendMessage("hi")).rejects.toThrow("not running");
  });

  it("rejects when another message is in-flight", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const first = proc.sendMessage("hello");
    await expect(proc.sendMessage("second")).rejects.toThrow("already in-flight");

    // Resolve first to clean up
    feedLine(child, { type: "result", session_id: "s", total_cost_usd: 0, num_turns: 1, duration_ms: 1 });
    await first;
  });

  it("resolves with prose text, sessionId, durationMs, and numTurns on result", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const textChunks: string[] = [];
    const promise = proc.sendMessage("hello", (t) => textChunks.push(t));

    // Simulate stream events
    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
    });
    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "world!" } },
    });
    feedLine(child, {
      type: "result",
      session_id: "sid-result",
      total_cost_usd: 0.05,
      num_turns: 2,
      duration_ms: 1500,
    });

    const result = await promise;
    expect(result.text).toBe("Hello world!");
    expect(result.sessionId).toBe("sid-result");
    expect(result.durationMs).toBe(1500);
    expect(result.numTurns).toBe(2);
    expect(textChunks).toEqual(["Hello ", "world!"]);
  });

  it("times out and resolves with partial prose after TURN_TIMEOUT_MS", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const promise = proc.sendMessage("hello");

    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    });

    // Advance past the 10-minute timeout
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);

    const result = await promise;
    expect(result.text).toBe("partial");
  });

  it("rejects when stdin write fails", async () => {
    const child = createFakeChild();
    child._stdin.write = vi.fn((_data: string, cb?: (err?: Error) => void) => {
      cb?.(new Error("EPIPE"));
    });
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    await expect(proc.sendMessage("test")).rejects.toThrow("EPIPE");
  });

  it("aborts turn via signal", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const ac = new AbortController();
    const promise = proc.sendMessage("hello", undefined, ac.signal);

    ac.abort();

    await expect(promise).rejects.toThrow("aborted");
  });

  it("isBusy() returns true during a turn and false after", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    expect(proc.isBusy()).toBe(false);
    const promise = proc.sendMessage("hi");
    expect(proc.isBusy()).toBe(true);

    feedLine(child, { type: "result", session_id: "s", total_cost_usd: 0, num_turns: 1, duration_ms: 1 });
    await promise;

    expect(proc.isBusy()).toBe(false);
  });
});

// ===========================================================================
// Event handler dispatch via processLine
// ===========================================================================

describe("ClaudeProcess.processLine event dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("handles system init event — sets sessionId", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedLine(child, { type: "system", subtype: "init", session_id: "sess-abc123def" });

    expect(proc.getSessionId()).toBe("sess-abc123def");
  });

  it("handles system non-init event silently", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedLine(child, { type: "system", subtype: "progress" });

    // No crash, no warning for known type
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("unhandled event"),
    );
  });

  it("warns on unhandled event types", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedLine(child, { type: "unknown_type", subtype: "foo" });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unhandled event type="unknown_type"'),
    );
  });

  it("warns on unparseable JSON lines", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedRaw(child, "not valid json\n");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unparseable line"),
    );
  });

  it("skips empty lines", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedRaw(child, "\n\n  \n");

    // No warnings for empty lines
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("unparseable"),
    );
  });
});

// ===========================================================================
// handleRateLimitEvent
// ===========================================================================

describe("ClaudeProcess.handleRateLimitEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records rate limit info and warns when status is not allowed", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rate_limited",
        rateLimitType: "five_hour",
        resetsAt: 1717000000,
        utilization: 0.95,
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("rate limit five_hour status=rate_limited"),
    );
  });

  it("does not warn when status is allowed", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "minute",
      },
    });

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("rate limit"),
    );
  });

  it("ignores rate_limit_event with no rate_limit_info", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    feedLine(child, { type: "rate_limit_event" });

    // No crash
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("rate limit"),
    );
  });
});

// ===========================================================================
// handleStreamEvent
// ===========================================================================

describe("ClaudeProcess.handleStreamEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accumulates prose text from content_block_delta", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk1" } },
    });
    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "chunk2" } },
    });

    expect((proc as any).turnProseText).toBe("chunk1chunk2");
  });

  it("ignores non-text deltas", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    });

    expect((proc as any).turnProseText).toBe("");
  });

  it("records input tokens from message_start", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      },
    });

    const usage = (proc as any).usage;
    expect(usage.turnInputTokens).toBe(100);
    expect(usage.turnCacheRead).toBe(50);
    expect(usage.turnCacheCreation).toBe(25);
    expect(usage.turnContextTokens).toBe(175); // 100+50+25
  });

  it("records output tokens from message_delta", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 42 } },
    });

    expect((proc as any).usage.turnOutputTokens).toBe(42);
  });

  it("ignores stream_event with no inner event", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, { type: "stream_event" });

    // No crash
    expect((proc as any).turnProseText).toBe("");
  });
});

// ===========================================================================
// handleResult
// ===========================================================================

describe("ClaudeProcess.handleResult", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("resolves the turn with cost, numTurns, durationMs", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const promise = proc.sendMessage("hello");

    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    });
    feedLine(child, {
      type: "result",
      session_id: "sid-r",
      total_cost_usd: 0.01,
      num_turns: 3,
      duration_ms: 500,
    });

    const result = await promise;
    expect(result.text).toBe("hi");
    expect(result.durationMs).toBe(500);
    expect(result.numTurns).toBe(3);
    expect(proc.getTotalCost()).toBeCloseTo(0.01);
  });

  it("rejects when result has is_error and no prose text", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const promise = proc.sendMessage("hello");

    feedLine(child, {
      type: "result",
      session_id: "sid-err",
      is_error: true,
      errors: ["rate limited", "timeout"],
    });

    await expect(promise).rejects.toThrow("rate limited; timeout");
  });

  it("rejects when result has subtype error_during_execution and no prose", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const promise = proc.sendMessage("hello");

    feedLine(child, {
      type: "result",
      session_id: "sid-err2",
      subtype: "error_during_execution",
      result: "something broke",
    });

    await expect(promise).rejects.toThrow("something broke");
  });

  it("resolves (not rejects) when result has error but there is prose text", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const promise = proc.sendMessage("hello");

    feedLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial answer" } },
    });
    feedLine(child, {
      type: "result",
      session_id: "sid-partial-err",
      is_error: true,
      errors: ["execution error"],
      total_cost_usd: 0.02,
      num_turns: 1,
      duration_ms: 200,
    });

    const result = await promise;
    expect(result.text).toBe("partial answer");
  });
});

// ===========================================================================
// handleStaleResult
// ===========================================================================

describe("ClaudeProcess.handleStaleResult", () => {
  beforeEach(() => vi.clearAllMocks());

  it("decrements staleResults and tracks cost from aborted result", () => {
    const proc = new ClaudeProcess({ logger });
    (proc as any).staleResults = 2;

    (proc as any).processLine(JSON.stringify({
      type: "result",
      session_id: "stale-sid",
      total_cost_usd: 0.03,
    }));

    expect((proc as any).staleResults).toBe(1);
    expect(proc.getTotalCost()).toBeCloseTo(0.03);
    expect(proc.getSessionId()).toBe("stale-sid");
  });

  it("clears stale drain timer when staleResults reaches 0", () => {
    vi.useFakeTimers();
    const proc = new ClaudeProcess({ logger });
    (proc as any).staleResults = 1;
    (proc as any).ensureStaleDrainTimer();

    (proc as any).processLine(JSON.stringify({
      type: "result",
      session_id: "sid-last",
    }));

    expect((proc as any).staleResults).toBe(0);
    expect((proc as any).staleDrainTimer).toBeNull();
    vi.useRealTimers();
  });

  it("skips stream_event, assistant, user events while draining stale", () => {
    const proc = new ClaudeProcess({ logger });
    (proc as any).staleResults = 1;
    primeTurn(proc);

    (proc as any).processLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "skipped" } },
    }));
    (proc as any).processLine(JSON.stringify({ type: "assistant", message: {} }));
    (proc as any).processLine(JSON.stringify({ type: "user", message: {} }));

    // Prose should not have accumulated
    expect((proc as any).turnProseText).toBe("");
  });
});

// ===========================================================================
// stop()
// ===========================================================================

describe("ClaudeProcess.stop()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it("resolves immediately if no child process", async () => {
    const proc = new ClaudeProcess({ logger });
    await proc.stop(); // No error
  });

  it("sends SIGTERM and resolves on close", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const stopPromise = proc.stop();

    // child.kill("SIGTERM") triggers setTimeout => close event
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(proc.isAlive()).toBe(false);
  });

  it("rejects pending turn when stopped", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const rejectFn = vi.fn();
    (proc as any).turnReject = rejectFn;
    (proc as any).turnResolve = vi.fn();

    const stopPromise = proc.stop();
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(rejectFn).toHaveBeenCalledWith(expect.objectContaining({
      message: "Claude process stopped",
    }));
  });

  it("sends SIGKILL after 5s if process hasn't exited", async () => {
    const child = createFakeChild();
    // Override kill to not auto-close
    child.kill = vi.fn(() => true);
    child.killed = false;
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const stopPromise = proc.stop();

    // Advance past 5s SIGKILL timeout
    await vi.advanceTimersByTimeAsync(5001);

    // SIGKILL should have been sent
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // Simulate close after kill
    child.emit("close", 9);
    await stopPromise;
  });
});

// ===========================================================================
// restart()
// ===========================================================================

describe("ClaudeProcess.restart()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops and starts the process", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const stopSpy = vi.spyOn(proc, "stop").mockResolvedValue();
    const startSpy = vi.spyOn(proc, "start").mockImplementation(() => {});

    await proc.restart();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// UsageTracker (accessed through ClaudeProcess)
// ===========================================================================

describe("UsageTracker via ClaudeProcess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getWindowUsage returns undefined when no turns committed", () => {
    const proc = new ClaudeProcess({ logger });
    expect(proc.getWindowUsage()).toBeUndefined();
  });

  it("tracks window usage across turns with five_hour rate limit", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    // Turn 1
    const p1 = proc.sendMessage("t1");
    feedLine(child, {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 9999 },
    });
    feedLine(child, {
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    });
    feedLine(child, {
      type: "stream_event",
      event: { type: "message_delta", usage: { output_tokens: 50 } },
    });
    feedLine(child, {
      type: "result",
      session_id: "s1",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 100,
    });
    await p1;

    const wu = proc.getWindowUsage();
    expect(wu).toBeDefined();
    expect(wu!.inputTokens).toBe(100);
    expect(wu!.outputTokens).toBe(50);
    expect(wu!.costUsd).toBeCloseTo(0.01);
    expect(wu!.turns).toBe(1);
    expect(wu!.resetsAt).toBe(9999);
  });

  it("resets window counters when five_hour resetsAt changes", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    // Turn 1: window with resetsAt=1000
    const p1 = proc.sendMessage("t1");
    feedLine(child, {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1000 },
    });
    feedLine(child, {
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    });
    feedLine(child, { type: "result", session_id: "s", total_cost_usd: 0.05, num_turns: 1, duration_ms: 10 });
    await p1;

    // Turn 2: new window with resetsAt=2000 — counters should reset
    const p2 = proc.sendMessage("t2");
    feedLine(child, {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 2000 },
    });
    feedLine(child, {
      type: "stream_event",
      event: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    });
    feedLine(child, { type: "result", session_id: "s", total_cost_usd: 0.001, num_turns: 1, duration_ms: 5 });
    await p2;

    const wu = proc.getWindowUsage();
    expect(wu!.resetsAt).toBe(2000);
    // Should only reflect turn 2 usage (window was reset)
    expect(wu!.inputTokens).toBe(10);
    expect(wu!.costUsd).toBeCloseTo(0.001);
    expect(wu!.turns).toBe(1);
  });

  it("recordRateLimit handles all optional fields", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;

    const rl = usage.recordRateLimit({
      status: "rate_limited",
      rateLimitType: "minute",
      resetsAt: 12345,
      overageStatus: "overaged",
      overageResetsAt: 99999,
      isUsingOverage: true,
      utilization: 0.8,
    });

    expect(rl.status).toBe("rate_limited");
    expect(rl.rateLimitType).toBe("minute");
    expect(rl.resetsAt).toBe(12345);
    expect(rl.overageStatus).toBe("overaged");
    expect(rl.overageResetsAt).toBe(99999);
    expect(rl.isUsingOverage).toBe(true);
    expect(rl.utilization).toBe(0.8);
  });

  it("recordRateLimit uses defaults for missing fields", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;

    const rl = usage.recordRateLimit({});
    expect(rl.status).toBe("unknown");
    expect(rl.rateLimitType).toBe("unknown");
    expect(rl.resetsAt).toBeUndefined();
    expect(rl.overageStatus).toBeUndefined();
    expect(rl.overageResetsAt).toBeUndefined();
    expect(rl.isUsingOverage).toBeUndefined();
    expect(rl.utilization).toBeUndefined();
  });

  it("recordMessageStart accumulates tokens", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;
    usage.resetTurn();

    usage.recordMessageStart({ input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 });
    usage.recordMessageStart({ input_tokens: 20 });

    expect(usage.turnInputTokens).toBe(30);
    expect(usage.turnCacheRead).toBe(5);
    expect(usage.turnCacheCreation).toBe(3);
    expect(usage.turnContextTokens).toBe(20); // Last call wins
  });

  it("recordMessageDelta accumulates output tokens", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;
    usage.resetTurn();

    usage.recordMessageDelta({ output_tokens: 10 });
    usage.recordMessageDelta({ output_tokens: 20 });

    expect(usage.turnOutputTokens).toBe(30);
  });

  it("recordResult resolves model from modelUsage fallback (no configuredModel)", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;
    usage.resetTurn();

    usage.recordResult({
      total_cost_usd: 0.1,
      num_turns: 2,
      duration_ms: 1000,
      modelUsage: {
        "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 5, maxOutputTokens: 8192 },
        "claude-opus-4": { contextWindow: 1_000_000, outputTokens: 500, maxOutputTokens: 32000 },
      },
    }, undefined);

    expect(usage.resolvedModel).toBe("claude-opus-4");
    expect(usage.turnMaxOutputTokens).toBe(32000);
    expect(usage.turnContextWindow).toBe(1_000_000);
    expect(usage.totalCostUsd).toBeCloseTo(0.1);
    expect(usage.turnNumTurns).toBe(2);
    expect(usage.turnDurationMs).toBe(1000);
  });

  it("recordStaleCost adds cost without affecting turn state", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;
    usage.resetTurn();

    usage.recordStaleCost({ total_cost_usd: 0.05 });
    expect(usage.totalCostUsd).toBeCloseTo(0.05);
    expect(usage.turnCostUsd).toBeUndefined();
  });

  it("commitTurn persists context with fallback contextWindow from MODEL_CONTEXT_WINDOWS", () => {
    const proc = new ClaudeProcess({ logger });
    const usage = (proc as any).usage;
    usage.resetTurn();

    // Simulate a turn with known model but no turnContextWindow
    usage.turnContextTokens = 5000;
    usage.resolvedModel = "claude-opus-4-6";
    // turnContextWindow is undefined — should fall back to MODEL_CONTEXT_WINDOWS

    usage.commitTurn();

    const ctx = usage.lastContext;
    expect(ctx).toBeDefined();
    expect(ctx.contextTokens).toBe(5000);
    expect(ctx.contextWindow).toBe(1_000_000); // from MODEL_CONTEXT_WINDOWS
  });
});

// ===========================================================================
// Public accessors
// ===========================================================================

describe("ClaudeProcess public accessors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getSessionId returns resumeSessionId when no session started", () => {
    const proc = new ClaudeProcess({ logger, resumeSessionId: "resume-123" });
    expect(proc.getSessionId()).toBe("resume-123");
  });

  it("getSessionId returns empty string when nothing set", () => {
    const proc = new ClaudeProcess({ logger });
    expect(proc.getSessionId()).toBe("");
  });

  it("getCwd returns opts.cwd", () => {
    const proc = new ClaudeProcess({ logger, cwd: "/tmp/work" });
    expect(proc.getCwd()).toBe("/tmp/work");
  });

  it("getModel returns opts.model when resolvedModel is not set", () => {
    const proc = new ClaudeProcess({ logger, model: "claude-opus-4" });
    expect(proc.getModel()).toBe("claude-opus-4");
  });

  it("getRateLimits returns the map", () => {
    const proc = new ClaudeProcess({ logger });
    expect(proc.getRateLimits()).toBeInstanceOf(Map);
  });

  it("getContext returns undefined initially", () => {
    const proc = new ClaudeProcess({ logger });
    expect(proc.getContext()).toBeUndefined();
  });

  it("getTotalCost starts at 0", () => {
    const proc = new ClaudeProcess({ logger });
    expect(proc.getTotalCost()).toBe(0);
  });

  it("isAlive returns false initially", () => {
    const proc = new ClaudeProcess({ logger });
    expect(proc.isAlive()).toBe(false);
  });
});

// ===========================================================================
// setReportToolCall
// ===========================================================================

describe("ClaudeProcess.setReportToolCall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates the reporter on a live process", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const reports: any[] = [];
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    proc.setReportToolCall((r) => reports.push(r));
    primeTurn(proc);

    feedLine(child, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
    });
    feedLine(child, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(reports).toHaveLength(1);
    expect(reports[0].toolName).toBe("Bash");
  });
});

// ===========================================================================
// toolResultContentToString via captureToolResults error path
// ===========================================================================

describe("toolResultContentToString edge cases via tool call reporting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flattens plain string error content", async () => {
    const reports: any[] = [];
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, reportToolCall: (r) => reports.push(r) }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "e1", name: "Read", input: {} }] },
    });
    feedLine(child, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e1", content: "plain error string", is_error: true }] },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(reports[0].error).toBe("plain error string");
  });

  it("handles string blocks in array content", async () => {
    const reports: any[] = [];
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, reportToolCall: (r) => reports.push(r) }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "e2", name: "Read", input: {} }] },
    });
    feedLine(child, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e2", content: ["str_block"], is_error: true }] },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(reports[0].error).toBe("str_block");
  });

  it("handles array with non-text objects (falls through to empty string)", async () => {
    const reports: any[] = [];
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, reportToolCall: (r) => reports.push(r) }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "e3", name: "Read", input: {} }] },
    });
    feedLine(child, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "e3", content: [{ type: "image", data: "..." }], is_error: true }] },
    });

    await Promise.resolve();
    await Promise.resolve();
    // The image object has no .text property, so it yields "" and is filtered out
    expect(reports[0].error).toBe("");
  });
});

// ===========================================================================
// Reporter error handling
// ===========================================================================

describe("ClaudeProcess reporter error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("catches and logs reporter errors without breaking the turn", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({
      logger,
      reportToolCall: () => { throw new Error("reporter boom"); },
    }, spawner);
    proc.start();
    primeTurn(proc);

    feedLine(child, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Bash", input: {} }] },
    });
    feedLine(child, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "ok" }] },
    });

    // Wait for the microtask queue to process the error
    await new Promise((r) => setTimeout(r, 10));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reportToolCall failed"),
    );
  });
});

// ===========================================================================
// abortTurn / signal cleanup
// ===========================================================================

describe("ClaudeProcess.abortTurn()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing if no turn in progress", () => {
    const proc = new ClaudeProcess({ logger });
    // Should not throw
    proc.abortTurn();
  });

  it("clears signal listener on abort", async () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    const ac = new AbortController();
    const promise = proc.sendMessage("hello", undefined, ac.signal);

    proc.abortTurn();
    await expect(promise).rejects.toThrow("aborted");

    // The signal listener should be cleaned up
    expect((proc as any).turnSignal).toBeNull();
    expect((proc as any).turnSignalListener).toBeNull();
  });
});

// ===========================================================================
// scheduleRestart deduplication
// ===========================================================================

describe("ClaudeProcess.scheduleRestart()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deduplicates concurrent restart calls", async () => {
    const proc = new ClaudeProcess({ logger });
    const restartSpy = vi.spyOn(proc, "restart").mockResolvedValue();

    const p1 = (proc as any).scheduleRestart();
    const p2 = (proc as any).scheduleRestart();

    expect(p1).toBe(p2); // Same promise instance
    await p1;

    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  it("logs error when restart fails", async () => {
    const proc = new ClaudeProcess({ logger });
    vi.spyOn(proc, "restart").mockRejectedValue(new Error("restart failed"));

    try {
      await (proc as any).scheduleRestart();
    } catch {
      // Expected
    }

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("restart failed"),
    );
  });
});

// ===========================================================================
// messageId propagation
// ===========================================================================

describe("ClaudeProcess messageId propagation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes messageId to tool call reports", async () => {
    const reports: any[] = [];
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({
      logger,
      reportToolCall: (r) => reports.push(r),
    }, spawner);
    proc.start();

    const promise = proc.sendMessage("hi", undefined, undefined, "msg-42");

    feedLine(child, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    });
    feedLine(child, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    feedLine(child, { type: "result", session_id: "s", total_cost_usd: 0, num_turns: 1, duration_ms: 1 });

    await promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(reports[0].messageId).toBe("msg-42");
  });
});

// ===========================================================================
// logTag with agentName
// ===========================================================================

describe("ClaudeProcess logTag", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes agentName in log messages when set", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger, agentName: "alice" }, spawner);
    proc.start();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("claude-process[alice]"),
    );
  });

  it("uses plain logTag when agentName is unset", () => {
    const child = createFakeChild();
    const spawner = createMockSpawner(child);
    const proc = new ClaudeProcess({ logger }, spawner);
    proc.start();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/^claude-process: spawning/),
    );
  });
});
