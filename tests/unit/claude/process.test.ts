import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProcess } from "../../../src/claude/process.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("ClaudeProcess stale drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts when aborted turn stale result does not arrive in time", async () => {
    const process = new ClaudeProcess({ logger });
    const reject = vi.fn();
    const restart = vi.spyOn(process, "restart").mockResolvedValue();

    (process as any).turnReject = reject;

    process.abortTurn();
    await vi.advanceTimersByTimeAsync(5000);

    expect(reject).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart when stale result is drained", async () => {
    const process = new ClaudeProcess({ logger });
    const restart = vi.spyOn(process, "restart").mockResolvedValue();

    (process as any).staleResults = 1;
    (process as any).ensureStaleDrainTimer();
    (process as any).processLine("{\"type\":\"result\",\"session_id\":\"sid\"}");
    await vi.advanceTimersByTimeAsync(5000);

    expect(restart).not.toHaveBeenCalled();
  });
});
