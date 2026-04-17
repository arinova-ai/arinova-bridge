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

  it("picks the model with the most output tokens (Opus beats Haiku sub-agent)", () => {
    const process = new ClaudeProcess({ logger, model: "claude-opus-4" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 120, maxOutputTokens: 8_192 },
      "claude-opus-4": { contextWindow: 200_000, outputTokens: 4_300, maxOutputTokens: 32_000 },
    }));

    expect(process.getModel()).toBe("claude-opus-4");
    expect(process.getContext()?.maxOutputTokens).toBe(32_000);
  });

  it("picks Sonnet when Sonnet has the most output tokens", () => {
    const process = new ClaudeProcess({ logger, model: "claude-sonnet-4" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 50, maxOutputTokens: 8_192 },
      "claude-sonnet-4": { contextWindow: 200_000, outputTokens: 2_100, maxOutputTokens: 64_000 },
    }));

    expect(process.getModel()).toBe("claude-sonnet-4");
    expect(process.getContext()?.maxOutputTokens).toBe(64_000);
  });

  it("falls back to opts.model when modelUsage has no outputTokens field", () => {
    const process = new ClaudeProcess({ logger, model: "claude-opus-4" });
    (process as any).turnResolve = () => {};
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000 },
    }));

    expect(process.getModel()).toBe("claude-opus-4");
  });

  it("still tracks the largest contextWindow across models", () => {
    const process = new ClaudeProcess({ logger, model: "claude-opus-4" });
    (process as any).turnResolve = () => {};
    (process as any).turnContextTokens = 10_000;
    (process as any).processLine(makeResultLine({
      "claude-haiku-4-5": { contextWindow: 200_000, outputTokens: 10 },
      "claude-opus-4":    { contextWindow: 1_000_000, outputTokens: 500 },
    }));

    expect(process.getContext()?.contextWindow).toBe(1_000_000);
    expect(process.getModel()).toBe("claude-opus-4");
  });
});
