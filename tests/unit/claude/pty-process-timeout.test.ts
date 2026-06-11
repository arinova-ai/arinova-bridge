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
