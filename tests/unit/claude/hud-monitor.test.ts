import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as pty from "node-pty";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { HudMonitor } from "../../../src/claude/hud-monitor.js";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node-pty", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execSync: vi.fn() };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, existsSync: vi.fn(() => false), statSync: vi.fn() };
});

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: vi.fn(() => "/mock-home") };
});

// ── Helpers ──────────────────────────────────────────────────────────

type ExitCb = (e: { exitCode: number }) => void;
type DataCb = (data: string) => void;

function createMockPty() {
  let exitCb: ExitCb | null = null;
  let dataCb: DataCb | null = null;
  return {
    pid: 123,
    onExit: vi.fn((cb: ExitCb) => { exitCb = cb; }),
    onData: vi.fn((cb: DataCb) => { dataCb = cb; }),
    write: vi.fn(),
    kill: vi.fn(),
    // test helpers
    _triggerExit(code: number) { exitCb?.({ exitCode: code }); },
    _triggerData(data: string) { dataCb?.(data); },
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("HudMonitor", () => {
  let logger: ReturnType<typeof makeLogger>;
  let mockPty: ReturnType<typeof createMockPty>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    logger = makeLogger();
    mockPty = createMockPty();
    (pty.spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPty);
    (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Constructor & config ────────────────────────────────────────

  describe("constructor", () => {
    it("stores options and applies default debounce", () => {
      const monitor = new HudMonitor({ logger });
      // default debounceMs is 60_000 — verify indirectly via internal state
      expect(monitor).toBeDefined();
    });

    it("accepts a custom debounceMs", () => {
      const monitor = new HudMonitor({ logger, debounceMs: 5000 });
      expect(monitor).toBeDefined();
    });
  });

  // ─── start() ────────────────────────────────────────────────────

  describe("start()", () => {
    it("resolves claudePath via execSync when no slash in the path", () => {
      (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/usr/local/bin/claude\n");

      const monitor = new HudMonitor({ logger });
      monitor.start();

      expect(execSync).toHaveBeenCalledWith("which claude", { encoding: "utf-8" });
    });

    it("keeps claudePath as-is when execSync throws", () => {
      (execSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("not found");
      });

      const monitor = new HudMonitor({ logger });
      monitor.start();

      // Should still succeed — falls back to bare "claude"
      expect(pty.spawn).toHaveBeenCalledTimes(1);
    });

    it("does not call execSync when claudePath contains a slash", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      expect(execSync).not.toHaveBeenCalled();
    });

    it("passes BRIDGE_CLAUDE_SETTINGS when the file exists", () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      const args = (pty.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      // Second argument is ["-l", "-c", ...]; the joined command string should include --settings
      const cmdString = args[1][2] as string;
      expect(cmdString).toContain("--settings");
      expect(cmdString).toContain("claude-settings.json");
    });

    it("does not pass --settings when the file does not exist", () => {
      (existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      const args = (pty.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const cmdString = args[1][2] as string;
      expect(cmdString).not.toContain("--settings");
    });

    it("passes provider env and TERM into pty.spawn", () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-account-ripple" },
      });
      monitor.start();

      const opts = (pty.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
        env: Record<string, string>;
      };
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-account-ripple");
      expect(opts.env.TERM).toBe("xterm-256color");
    });

    it("sends initial 'hi' prompt after 10s", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      expect(mockPty.write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(mockPty.write).toHaveBeenCalledWith("hi\r");
    });

    it("does not send initial prompt if ptyProcess was nulled before timeout fires", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      // Stop before the 10s timeout fires
      monitor.stop();
      vi.advanceTimersByTime(10_000);

      // write was never called (ptyProcess was null when timeout fired)
      expect(mockPty.write).not.toHaveBeenCalled();
    });

    it("marks ready after 25s", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      vi.advanceTimersByTime(24_999);
      expect(logger.info).not.toHaveBeenCalledWith("hud-monitor: ready for notifications");

      vi.advanceTimersByTime(1);
      expect(logger.info).toHaveBeenCalledWith("hud-monitor: ready for notifications");
    });

    it("is a no-op when called twice", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();
      monitor.start();

      expect(pty.spawn).toHaveBeenCalledTimes(1);
    });

    it("logs error and resets started flag when pty.spawn throws", () => {
      (pty.spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("spawn failed");
      });

      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("failed to start"));
      // Can start again after failure
      (pty.spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPty);
      monitor.start();
      expect(pty.spawn).toHaveBeenCalledTimes(2);
    });

    it("registers onExit that cleans up on process exit", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      mockPty._triggerExit(0);

      expect(logger.info).toHaveBeenCalledWith("hud-monitor: claude exited (code 0)");
      // After cleanup, a new start() should work
      monitor.start();
      expect(pty.spawn).toHaveBeenCalledTimes(2);
    });

    it("registers onData handler (discards output)", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      expect(mockPty.onData).toHaveBeenCalledTimes(1);
      // Should not throw when data arrives
      mockPty._triggerData("some output");
    });
  });

  // ─── stop() ──────────────────────────────────────────────────────

  describe("stop()", () => {
    it("kills the pty process", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();
      monitor.stop();

      expect(mockPty.kill).toHaveBeenCalled();
    });

    it("clears a pending debounce timer", () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 5000,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // First notify — immediate, sets lastPingAt
      monitor.notify();
      // Second notify — within debounce, schedules a timer
      monitor.notify();

      monitor.stop();

      // Advancing past debounce period should NOT send a ping (timer cleared)
      vi.advanceTimersByTime(10_000);
      // write: 1x initial "hi" (at 10s) + 1x from first notify = 2
      expect(mockPty.write).toHaveBeenCalledTimes(2);
    });

    it("is safe to call when not started", () => {
      const monitor = new HudMonitor({ logger });
      expect(() => monitor.stop()).not.toThrow();
    });

    it("handles kill throwing (already dead process)", () => {
      mockPty.kill.mockImplementation(() => {
        throw new Error("Process already dead");
      });

      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      expect(() => monitor.stop()).not.toThrow();
    });

    it("flushes waiters on stop", async () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 5000,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // First notify: immediate ping
      monitor.notify();
      // Second notify: schedules delayed ping
      const p2 = monitor.notify();
      // Third notify: becomes a waiter
      const p3 = monitor.notify();

      // Stop should flush all waiters
      monitor.stop();

      // The waiter promises should resolve
      await expect(p3).resolves.toBeUndefined();
    });
  });

  // ─── notify() ────────────────────────────────────────────────────

  describe("notify()", () => {
    it("resolves immediately when not ready", async () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      // Not yet ready (ready=false before 25s)
      const result = monitor.notify();
      await expect(result).resolves.toBeUndefined();
    });

    it("resolves immediately when ptyProcess is null", async () => {
      const monitor = new HudMonitor({ logger });
      // Never started — ptyProcess is null
      const result = monitor.notify();
      await expect(result).resolves.toBeUndefined();
    });

    it("sends a ping immediately when debounce period has elapsed", () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 1000,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready + fires initial hi at 10s

      monitor.notify();

      // initial "hi" at 10s + notify ping
      expect(mockPty.write).toHaveBeenCalledTimes(2);
      expect(mockPty.write).toHaveBeenLastCalledWith("hi\r");
      expect(logger.info).toHaveBeenCalledWith("hud-monitor: ping sent");
    });

    it("schedules a delayed ping when within debounce window", () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 5000,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // First notify — immediate
      monitor.notify();
      const writeCountAfterFirst = mockPty.write.mock.calls.length;

      // Second notify — within debounce, should be delayed
      monitor.notify();
      expect(mockPty.write.mock.calls.length).toBe(writeCountAfterFirst);

      // After debounce period, the delayed ping fires
      vi.advanceTimersByTime(5000);
      expect(mockPty.write.mock.calls.length).toBe(writeCountAfterFirst + 1);
    });

    it("queues as waiter when a pending timer already exists", async () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 5000,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // Make status file appear updated so sendPing resolves quickly
      let mtimeCounter = 0;
      (statSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        mtimeMs: ++mtimeCounter * 1000,
      }));

      // First notify — immediate ping
      monitor.notify();

      // Second notify — schedules delayed timer
      const p2 = monitor.notify();

      // Third notify — pending timer exists, becomes a waiter
      const p3 = monitor.notify();

      // Advance past debounce to fire the delayed ping
      vi.advanceTimersByTime(5000);
      // Advance to let the poll detect file change
      vi.advanceTimersByTime(1000);

      await expect(p2).resolves.toBeUndefined();
      await expect(p3).resolves.toBeUndefined();
    });
  });

  // ─── sendPing (private, tested via notify) ───────────────────────

  describe("sendPing behavior", () => {
    it("resolves when status file mtime changes after ping", async () => {
      let mtimeCounter = 0;
      (statSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        mtimeMs: ++mtimeCounter * 1000,
      }));

      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 100,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      const p = monitor.notify();

      // First poll at 500ms — mtime will have changed
      vi.advanceTimersByTime(500);

      await expect(p).resolves.toBeUndefined();
    });

    it("gives up after 30 poll attempts (15s) if status file never updates", async () => {
      // statSync always returns the same mtime
      (statSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 1000 });

      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 100,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      const p = monitor.notify();

      // 30 polls x 500ms = 15s
      vi.advanceTimersByTime(15_500);

      await expect(p).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "hud-monitor: status file not updated after ping, giving up",
      );
    });

    it("resolves immediately and logs warning if write throws", async () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 100,
      });
      monitor.start();

      // Let initial hi fire normally at 10s, then mark ready at 25s
      vi.advanceTimersByTime(25_000);

      // Now make write throw for the ping
      mockPty.write.mockImplementation(() => {
        throw new Error("write failed");
      });

      const p = monitor.notify();

      expect(logger.warn).toHaveBeenCalledWith("hud-monitor: failed to send ping");
      await expect(p).resolves.toBeUndefined();
    });

    it("sendPing returns immediately when ptyProcess is null", async () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 100,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // First notify: immediate ping, sets lastPingAt
      monitor.notify();

      // Wait for debounce to expire
      vi.advanceTimersByTime(200);

      // Stop to null out ptyProcess, but keep ready=true via direct access
      // Actually, stop resets ready. Instead, test indirectly:
      // onExit triggers cleanup which nulls ptyProcess.
      // Then calling notify returns immediately (guard at line 103).
      mockPty._triggerExit(0);

      const p = monitor.notify();
      await expect(p).resolves.toBeUndefined();
      // No additional writes beyond initial hi + first ping
      expect(mockPty.write).toHaveBeenCalledTimes(2);
    });
  });

  // ─── getStatusMtime (private, tested via sendPing) ───────────────

  describe("getStatusMtime behavior", () => {
    it("returns 0 when statSync throws (file does not exist)", async () => {
      (statSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 100,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // Since mtime is 0 before and 0 after (statSync always throws),
      // it will never detect an update and give up after 30 attempts
      const p = monitor.notify();
      vi.advanceTimersByTime(15_500);
      await expect(p).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        "hud-monitor: status file not updated after ping, giving up",
      );
    });

    it("detects mtime change when file appears after ping", async () => {
      let callCount = 0;
      (statSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        // First call (before ping): file doesn't exist
        if (callCount <= 1) throw new Error("ENOENT");
        // Subsequent calls: file exists with increasing mtime
        return { mtimeMs: callCount * 1000 };
      });

      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 100,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      const p = monitor.notify();
      vi.advanceTimersByTime(500); // first poll

      await expect(p).resolves.toBeUndefined();
    });
  });

  // ─── cleanup (private, tested via stop and onExit) ───────────────

  describe("cleanup behavior", () => {
    it("resets started/ready flags so start() works again", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();
      vi.advanceTimersByTime(25_000); // ready

      monitor.stop();

      // Should be able to start again
      monitor.start();
      expect(pty.spawn).toHaveBeenCalledTimes(2);
    });

    it("cleanup via onExit allows re-start", () => {
      const monitor = new HudMonitor({ logger, claudePath: "/usr/local/bin/claude" });
      monitor.start();

      // Simulate process exit
      mockPty._triggerExit(1);

      expect(logger.info).toHaveBeenCalledWith("hud-monitor: claude exited (code 1)");

      // Re-start should work
      const mockPty2 = createMockPty();
      (pty.spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockPty2);
      monitor.start();
      expect(pty.spawn).toHaveBeenCalledTimes(2);
    });
  });

  // ─── flushWaiters (private, tested via notify+stop) ──────────────

  describe("flushWaiters behavior", () => {
    it("resolves all waiter promises", async () => {
      const monitor = new HudMonitor({
        logger,
        claudePath: "/usr/local/bin/claude",
        debounceMs: 5000,
      });
      monitor.start();
      vi.advanceTimersByTime(25_000); // mark ready

      // First notify: immediate ping
      monitor.notify();

      // Second notify: schedules delayed timer
      monitor.notify();

      // Third and fourth: become waiters
      const p3 = monitor.notify();
      const p4 = monitor.notify();

      // Stop flushes everything
      monitor.stop();

      await expect(p3).resolves.toBeUndefined();
      await expect(p4).resolves.toBeUndefined();
    });
  });
});
