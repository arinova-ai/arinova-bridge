import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { ClaudeProcess } from "../../../src/claude/process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn() };
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type EventHandler = (...args: any[]) => void;

function createMockChild() {
  const handlers = new Map<string, EventHandler>();
  return {
    pid: 999,
    killed: false,
    exitCode: null,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    kill: vi.fn((signal?: string) => {
      if (signal === "SIGINT") {
        handlers.get("close")?.(0);
      }
      return true;
    }),
    emit(event: string, ...args: any[]) {
      handlers.get(event)?.(...args);
    },
  };
}

describe("ClaudeProcess stale drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the process dead and sends SIGINT when aborting a turn", () => {
    const mockChild = createMockChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const process = new ClaudeProcess({ logger });
    process.start();
    (process as any).turnReject = vi.fn();

    process.abortTurn();

    expect(mockChild.kill).toHaveBeenCalledWith("SIGINT");
    expect(process.isAlive()).toBe(false);
  });

  it("restarts when aborted turn stale result does not arrive in time", async () => {
    const process = new ClaudeProcess({ logger });
    const reject = vi.fn();
    const restart = vi.spyOn(process, "restart").mockResolvedValue();

    (process as any).turnReject = reject;

    process.abortTurn();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(reject).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("restarts immediately when SIGINT closes the process while draining stale results", () => {
    const mockChild = createMockChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const process = new ClaudeProcess({ logger });
    process.start();
    const restart = vi.spyOn(process, "restart").mockResolvedValue();
    (process as any).turnReject = vi.fn();

    process.abortTurn();

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not double restart when close and stale drain timer both fire", async () => {
    const mockChild = createMockChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const process = new ClaudeProcess({ logger });
    process.start();
    const restart = vi.spyOn(process, "restart").mockResolvedValue();
    (process as any).turnReject = vi.fn();

    process.abortTurn();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart when stale result is drained", async () => {
    const process = new ClaudeProcess({ logger });
    const restart = vi.spyOn(process, "restart").mockResolvedValue();

    (process as any).staleResults = 1;
    (process as any).ensureStaleDrainTimer();
    (process as any).processLine("{\"type\":\"result\",\"session_id\":\"sid\"}");
    await vi.advanceTimersByTimeAsync(300_000);

    expect(restart).not.toHaveBeenCalled();
  });
});

describe("ClaudeProcess resolvedModel", () => {
  function makeResultLine(modelUsage: Record<string, Record<string, unknown>>): string {
    return JSON.stringify({
      type: "result",
      session_id: "sid",
      total_cost_usd: 0,
      num_turns: 1,
      duration_ms: 1,
      modelUsage,
    });
  }

  it("uses opts.model even when a Haiku sub-agent has more cumulative output tokens", () => {
    const process = new ClaudeProcess({ logger, model: "claude-opus-4" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 999_999, maxOutputTokens: 8_192 },
      "claude-opus-4":    { contextWindow: 200_000, outputTokens: 120,     maxOutputTokens: 32_000 },
    }));

    expect(process.getModel()).toBe("claude-opus-4");
    expect(process.getContext()?.maxOutputTokens).toBe(32_000);
  });

  it("matches opts.model alias to a full modelUsage key (opus -> claude-opus-4-5-20251022)", () => {
    const process = new ClaudeProcess({ logger, model: "opus" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5":         { contextWindow: 200_000, outputTokens: 500, maxOutputTokens: 8_192 },
      "claude-opus-4-5-20251022": { contextWindow: 200_000, outputTokens: 100, maxOutputTokens: 32_000 },
    }));

    expect(process.getModel()).toBe("opus");
    expect(process.getContext()?.maxOutputTokens).toBe(32_000);
  });

  it("uses opts.model for Sonnet regardless of Haiku cumulative usage", () => {
    const process = new ClaudeProcess({ logger, model: "claude-sonnet-4" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5":  { contextWindow: 200_000, outputTokens: 5_000, maxOutputTokens: 8_192 },
      "claude-sonnet-4":   { contextWindow: 200_000, outputTokens: 50,    maxOutputTokens: 64_000 },
    }));

    expect(process.getModel()).toBe("claude-sonnet-4");
    expect(process.getContext()?.maxOutputTokens).toBe(64_000);
  });

  it("falls back to largest-outputTokens model when opts.model is unset", () => {
    const process = new ClaudeProcess({ logger });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 50,    maxOutputTokens: 8_192 },
      "claude-opus-4":    { contextWindow: 200_000, outputTokens: 4_300, maxOutputTokens: 32_000 },
    }));

    expect(process.getModel()).toBe("claude-opus-4");
    expect(process.getContext()?.maxOutputTokens).toBe(32_000);
  });

  it("keeps opts.model as resolvedModel when modelUsage has no matching key", () => {
    const process = new ClaudeProcess({ logger, model: "claude-opus-4" });
    (process as any).turnResolve = () => {};
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 10 },
    }));

    expect(process.getModel()).toBe("claude-opus-4");
  });

  it("still tracks the largest contextWindow across models", () => {
    const process = new ClaudeProcess({ logger, model: "claude-opus-4" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000,   outputTokens: 10 },
      "claude-opus-4":    { contextWindow: 1_000_000, outputTokens: 500 },
    }));

    expect(process.getContext()?.contextWindow).toBe(1_000_000);
    expect(process.getModel()).toBe("claude-opus-4");
  });
});

describe("ClaudeProcess tool call capture", () => {
  function primeTurn(process: ClaudeProcess, turnId = "turn-test-uuid"): void {
    (process as any).turnResolve = () => {};
    (process as any).turnId = turnId;
    (process as any).pendingToolCalls = new Map();
    (process as any).turnToolCallSeq = 0;
    (process as any).sessionId = "sess-abc";
  }

  function toolUseLine(id: string, name: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name, input }],
      },
    });
  }

  function toolResultLine(toolUseId: string, content: unknown, isError = false): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
    });
  }

  it("reports a completed tool call with turnId, input, output, duration, and success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));

    const reports: any[] = [];
    const process = new ClaudeProcess({
      logger,
      reportToolCall: (r) => {
        reports.push(r);
      },
    });
    primeTurn(process, "turn-1");

    (process as any).processLine(toolUseLine("toolu_01", "Bash", { command: "ls" }));
    vi.setSystemTime(new Date("2026-04-17T00:00:00.250Z"));
    (process as any).processLine(toolResultLine("toolu_01", [{ type: "text", text: "file1\nfile2" }]));

    await Promise.resolve();
    await Promise.resolve();

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      sessionId: "sess-abc",
      turnId: "turn-1",
      seqOrder: 0,
      toolName: "Bash",
      input: { command: "ls" },
      success: true,
      durationMs: 250,
    });
    expect(reports[0].error).toBeUndefined();
    expect(reports[0].output).toEqual([{ type: "text", text: "file1\nfile2" }]);
    vi.useRealTimers();
  });

  it("reports success=false and flattens error content when is_error is true", async () => {
    const reports: any[] = [];
    const process = new ClaudeProcess({
      logger,
      reportToolCall: (r) => { reports.push(r); },
    });
    primeTurn(process);

    (process as any).processLine(toolUseLine("toolu_err", "Edit", { file: "x" }));
    (process as any).processLine(toolResultLine(
      "toolu_err",
      [{ type: "text", text: "file not found" }],
      true,
    ));

    await Promise.resolve();
    await Promise.resolve();

    expect(reports).toHaveLength(1);
    expect(reports[0].success).toBe(false);
    expect(reports[0].error).toBe("file not found");
    expect(reports[0].output).toBeUndefined();
  });

  it("assigns monotonically increasing seqOrder to tool calls within the same turn", async () => {
    const reports: any[] = [];
    const process = new ClaudeProcess({
      logger,
      reportToolCall: (r) => { reports.push(r); },
    });
    primeTurn(process);

    (process as any).processLine(toolUseLine("a", "Read", { path: "/a" }));
    (process as any).processLine(toolUseLine("b", "Read", { path: "/b" }));
    (process as any).processLine(toolUseLine("c", "Read", { path: "/c" }));
    (process as any).processLine(toolResultLine("b", "ok-b"));
    (process as any).processLine(toolResultLine("a", "ok-a"));
    (process as any).processLine(toolResultLine("c", "ok-c"));

    await Promise.resolve();
    await Promise.resolve();

    const seqByTool = Object.fromEntries(reports.map((r) => [r.input.path, r.seqOrder]));
    expect(seqByTool).toEqual({ "/a": 0, "/b": 1, "/c": 2 });
    expect(reports.map((r) => r.input.path)).toEqual(["/b", "/a", "/c"]);
  });

  it("shares the same turnId across every tool call in a turn", async () => {
    const reports: any[] = [];
    const process = new ClaudeProcess({
      logger,
      reportToolCall: (r) => { reports.push(r); },
    });
    primeTurn(process, "turn-shared");

    (process as any).processLine(toolUseLine("a", "Read", {}));
    (process as any).processLine(toolUseLine("b", "Read", {}));
    (process as any).processLine(toolResultLine("a", "x"));
    (process as any).processLine(toolResultLine("b", "y"));

    await Promise.resolve();
    await Promise.resolve();

    expect(reports.map((r) => r.turnId)).toEqual(["turn-shared", "turn-shared"]);
  });

  it("silently ignores tool_result blocks with no matching tool_use", async () => {
    const reports: any[] = [];
    const process = new ClaudeProcess({
      logger,
      reportToolCall: (r) => { reports.push(r); },
    });
    primeTurn(process);

    (process as any).processLine(toolResultLine("unknown-id", "stray"));

    await Promise.resolve();
    expect(reports).toHaveLength(0);
  });

  it("does not emit a report when reportToolCall is unset", async () => {
    const process = new ClaudeProcess({ logger });
    primeTurn(process);

    (process as any).processLine(toolUseLine("x", "Bash", { command: "ls" }));
    (process as any).processLine(toolResultLine("x", "ok"));

    await Promise.resolve();
    // No crash and pending map is drained
    expect((process as any).pendingToolCalls.size).toBe(0);
  });

  it("does not report tool calls discarded while draining a stale abort", async () => {
    const reports: any[] = [];
    const process = new ClaudeProcess({
      logger,
      reportToolCall: (r) => { reports.push(r); },
    });
    primeTurn(process);
    (process as any).staleResults = 1;

    (process as any).processLine(toolUseLine("stale", "Bash", { command: "ls" }));
    (process as any).processLine(toolResultLine("stale", "ok"));

    await Promise.resolve();
    expect(reports).toHaveLength(0);
  });

  it("generates a fresh turnId on each sendMessage call", () => {
    const mockChild = createMockChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const process = new ClaudeProcess({ logger });
    process.start();

    (process as any).child.stdin = { write: (_s: string, cb: (e?: Error) => void) => cb() };

    process.sendMessage("hello").catch(() => {});
    const first = (process as any).turnId as string;

    // Force-clean turn state, then send again (simulating next turn).
    (process as any).turnResolve = null;
    process.sendMessage("again").catch(() => {});
    const second = (process as any).turnId as string;

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    // UUID shape: 8-4-4-4-12 hex chars
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
