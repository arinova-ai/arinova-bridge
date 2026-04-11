import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { homedir } from "node:os";

const CLI_PATH = path.resolve(__dirname, "../../dist/cli.js");

function runCli(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("cli.ts", () => {
  describe("help command", () => {
    it("shows help with 'help' argument", () => {
      const { stdout, exitCode } = runCli("help");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("arinova-bridge");
      expect(stdout).toContain("COMMANDS");
      expect(stdout).toContain("start");
      expect(stdout).toContain("stop");
      expect(stdout).toContain("config");
      expect(stdout).toContain("setup");
    });

    it("shows help with --help flag", () => {
      const { stdout, exitCode } = runCli("--help");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("COMMANDS");
    });

    it("shows help with -h flag", () => {
      const { stdout, exitCode } = runCli("-h");
      expect(exitCode).toBe(0);
      expect(stdout).toContain("COMMANDS");
    });

    it("shows help when no arguments provided", () => {
      const { stdout, exitCode } = runCli();
      expect(exitCode).toBe(0);
      expect(stdout).toContain("COMMANDS");
    });

    it("includes install instructions", () => {
      const { stdout } = runCli("help");
      expect(stdout).toContain("INSTALL");
      expect(stdout).toContain("npm install -g");
    });

    it("includes config file format", () => {
      const { stdout } = runCli("help");
      expect(stdout).toContain("CONFIG FILE");
      expect(stdout).toContain("config.json");
    });

    it("includes multi-agent mode", () => {
      const { stdout } = runCli("help");
      expect(stdout).toContain("MULTI-AGENT");
      expect(stdout).toContain("agents");
    });

    it("includes environment variables", () => {
      const { stdout } = runCli("help");
      expect(stdout).toContain("ENVIRONMENT VARIABLES");
      expect(stdout).toContain("ARINOVA_SERVER_URL");
      expect(stdout).toContain("ARINOVA_BOT_TOKEN");
      expect(stdout).toContain("GITHUB_TOKEN");
    });
  });

  describe("version command", () => {
    it("shows version with --version flag", () => {
      const { stdout, exitCode } = runCli("--version");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("shows version with -v flag", () => {
      const { stdout, exitCode } = runCli("-v");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("unknown command", () => {
    it("exits with error for unknown command", () => {
      const { stderr, exitCode } = runCli("foobar");
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Unknown command: foobar");
    });
  });

  describe("stop command", () => {
    const pidFile = path.join(homedir(), ".arinova-bridge", "bridge.pid");
    let savedPid: string | null = null;

    beforeEach(() => {
      // Back up real PID file so the test never kills a running bridge
      try {
        savedPid = fs.readFileSync(pidFile, "utf-8");
        fs.unlinkSync(pidFile);
      } catch {
        savedPid = null;
      }
    });

    afterEach(() => {
      // Restore the PID file
      if (savedPid !== null) {
        fs.writeFileSync(pidFile, savedPid, "utf-8");
      }
    });

    it("exits with error when no PID file exists", () => {
      const { stderr, exitCode } = runCli("stop");
      expect(exitCode).toBe(1);
      expect(stderr).toContain("not running");
    });
  });

  describe("config command", () => {
    it("shows config with masked secrets", () => {
      const { stdout, exitCode } = runCli("config");
      // Config file exists in dev environment
      if (exitCode === 0) {
        const config = JSON.parse(stdout);
        // botToken should be masked
        if (config.arinova?.botToken) {
          expect(config.arinova.botToken).toMatch(/\.\.\./);
        }
      }
    });
  });
});
