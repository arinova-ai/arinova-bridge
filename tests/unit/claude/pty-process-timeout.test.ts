import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResponseTimeoutError } from "../../../src/pty/errors.js";
import { ClaudeState } from "../../../src/pty/types.js";

// Shared with the mock factory below (hoisted by vitest).
const mockPty = vi.hoisted(() => {
  const pty: any = {
    state: "IDLE", // ClaudeState.IDLE — enum not yet initialized in hoisted scope
    sessionId: "sid-pty",
    on: vi.fn(),
    start: vi.fn(async () => {}),
    send: vi.fn(),
    writeRaw: vi.fn(),
    close: vi.fn(async () => {}),
    kill: vi.fn(),
    dispose: vi.fn(),
  };
  return pty;
});

vi.mock("../../../src/pty/claude-pty.js", () => ({
  ClaudePty: vi.fn(function () {
    return mockPty;
  }),
}));

import { PtyProcess } from "../../../src/claude/pty-process.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

describe("PtyProcess timeout recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPty.state = ClaudeState.IDLE;
  });

  // Regression: the response timer only rejects the JS promise — the CLI
  // kept running, state stayed RESPONDING, and every subsequent send died
  // with "Cannot send: Claude is in state RESPONDING, expected IDLE".
  it("interrupts the stuck turn after a response timeout", async () => {
    mockPty.send.mockImplementation(async () => {
      mockPty.state = ClaudeState.RESPONDING;
      throw new ResponseTimeoutError();
    });
    // Ctrl+C lands → CLI returns to its prompt
    mockPty.writeRaw.mockImplementation((data: string) => {
      if (data === "\x03") mockPty.state = ClaudeState.IDLE;
    });

    const proc = new PtyProcess({ logger: makeLogger() });
    proc.start();

    await expect(proc.sendMessage("hello")).rejects.toThrow(
      "Response did not complete within timeout",
    );
    expect(mockPty.writeRaw).toHaveBeenCalledWith("\x03");
    expect(mockPty.state).toBe(ClaudeState.IDLE);
  });

  // Regression: when Ctrl+C fails to unstick a wedged tool call, the PTY
  // stayed pinned in TOOL_USE and every later send (retry, cron wake-up,
  // trigger) died with NOT_READY — the agent was dead until a manual reset.
  // A failed interrupt must now hard-restart the process.
  it("hard-restarts the process when the interrupt fails to recover", async () => {
    vi.useFakeTimers();
    try {
      // Turn times out and the CLI stays wedged in TOOL_USE...
      mockPty.send.mockImplementation(async () => {
        mockPty.state = ClaudeState.TOOL_USE;
        throw new ResponseTimeoutError();
      });
      // ...and Ctrl+C never brings it back to the prompt.
      mockPty.writeRaw.mockImplementation(() => {});

      const proc = new PtyProcess({ logger: makeLogger() });
      proc.start();

      const pending = proc.sendMessage("hello");
      // Attach the rejection assertion before advancing timers so the promise
      // never settles unhandled.
      const expectation = expect(pending).rejects.toThrow(
        "Response did not complete within timeout",
      );
      // Drive both 5s waitForIdle attempts plus the restart.
      await vi.advanceTimersByTimeAsync(11000);
      await expectation;

      // Two interrupt attempts (Ctrl+C), then a hard restart (stop →
      // close + dispose), then a fresh PTY brought back up.
      expect(mockPty.writeRaw).toHaveBeenCalledTimes(2);
      expect(mockPty.writeRaw).toHaveBeenCalledWith("\x03");
      expect(mockPty.close).toHaveBeenCalled();
      expect(mockPty.dispose).toHaveBeenCalled();
      // Process is alive again on a fresh PTY, ready for the next task.
      expect(proc.isAlive()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: restart()'s `await stop()` nulls the pty (so a raw state check
  // reads non-busy) and yields at an await — a window in which the session-store
  // idle sweep / max-sessions eviction (both skip only BUSY entries) could
  // delete the still-mapped entry and orphan the PTY being brought back.
  it("reports busy while a restart is in flight so the idle sweep skips it", async () => {
    const proc = new PtyProcess({ logger: makeLogger() });
    proc.start();
    expect(proc.isBusy()).toBe(false);

    // Hang stop()'s close() so we can observe the mid-restart window.
    let releaseClose!: () => void;
    mockPty.close.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseClose = () => resolve(); }),
    );

    const restarting = proc.restart();
    expect(proc.isBusy()).toBe(true);

    releaseClose();
    await restarting;
    expect(proc.isBusy()).toBe(false);
  });

  it("does not interrupt on other errors", async () => {
    mockPty.send.mockRejectedValue(new Error("some other failure"));

    const proc = new PtyProcess({ logger: makeLogger() });
    proc.start();

    await expect(proc.sendMessage("hello")).rejects.toThrow("some other failure");
    expect(mockPty.writeRaw).not.toHaveBeenCalledWith("\x03");
  });

  it("waitForIdle resolves true once the CLI returns to IDLE", async () => {
    mockPty.state = ClaudeState.RESPONDING;
    const proc = new PtyProcess({ logger: makeLogger() });
    proc.start();

    setTimeout(() => {
      mockPty.state = ClaudeState.IDLE;
    }, 150);
    await expect(proc.waitForIdle(2000)).resolves.toBe(true);
  });

  it("waitForIdle resolves false when the CLI stays busy", async () => {
    mockPty.state = ClaudeState.RESPONDING;
    const proc = new PtyProcess({ logger: makeLogger() });
    proc.start();

    await expect(proc.waitForIdle(300)).resolves.toBe(false);
  });
});
