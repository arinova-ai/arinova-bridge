import { describe, expect, it, vi, beforeEach } from "vitest";
import * as pty from "node-pty";
import { HudMonitor } from "../../../src/claude/hud-monitor.js";

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    pid: 123,
    onExit: vi.fn(),
    onData: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  })),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("HudMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes provider env into the node-pty Claude process", () => {
    const monitor = new HudMonitor({
      logger,
      claudePath: "/usr/local/bin/claude",
      env: { CLAUDE_CONFIG_DIR: "/tmp/claude-account-ripple" },
    });

    monitor.start();

    expect(pty.spawn).toHaveBeenCalledTimes(1);
    const opts = (pty.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
      env: Record<string, string>;
    };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-account-ripple");
    expect(opts.env.TERM).toBe("xterm-256color");
  });
});
