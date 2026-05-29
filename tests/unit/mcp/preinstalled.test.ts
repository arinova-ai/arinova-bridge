import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  lstatSync: vi.fn(),
  cpSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import {
  getPreinstalledMcpServers,
  ensureCliMcpConfig,
  ensureAgentCliMcpConfig,
  ensureCodexMcpServers,
  ensureAgentCodexHome,
} from "../../../src/mcp/preinstalled.js";
import type { FileSystem } from "../../../src/mcp/preinstalled.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";

const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockSymlinkSync = vi.mocked(symlinkSync);
const mockRmSync = vi.mocked(rmSync);
const mockLstatSync = vi.mocked(lstatSync);
const mockCpSync = vi.mocked(cpSync);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("mcp/preinstalled", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("getPreinstalledMcpServers", () => {
    it("returns playwright server by default", () => {
      const servers = getPreinstalledMcpServers();
      expect(servers.playwright).toBeDefined();
      expect(servers.playwright.type).toBe("stdio");
      expect(servers.playwright.command).toBe("npx");
      expect(servers.playwright.args).toContain("@playwright/mcp@0.0.68");
    });

    it("does not include github when no token", () => {
      const servers = getPreinstalledMcpServers();
      expect(servers.github).toBeUndefined();
    });

    it("includes github when GITHUB_TOKEN is set", () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const servers = getPreinstalledMcpServers();
      expect(servers.github).toBeDefined();
      expect(servers.github.command).toBe("npx");
      expect(servers.github.args).toContain("@modelcontextprotocol/server-github@2025.4.8");
      expect(servers.github.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_test123");
    });

    it("includes github when GITHUB_PERSONAL_ACCESS_TOKEN is set", () => {
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_alt456";
      const servers = getPreinstalledMcpServers();
      expect(servers.github).toBeDefined();
      expect(servers.github.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_alt456");
    });

    it("uses strict startup for the Arinova MCP server", () => {
      const servers = getPreinstalledMcpServers({
        botToken: "ari_test",
        serverUrl: "wss://chat.example.com",
      });

      expect(servers.arinova).toBeDefined();
      expect(servers.arinova.args).toContain("--strict-startup");
    });
  });

  describe("ensureCliMcpConfig", () => {
    it("returns user-provided path when set", () => {
      const result = ensureCliMcpConfig("/custom/path.json", mockLogger as never);
      expect(result).toBe("/custom/path.json");
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("generates config file when no user path", () => {
      mockExistsSync.mockReturnValue(false);
      const result = ensureCliMcpConfig(undefined, mockLogger as never);
      expect(result).toMatch(/preinstalled\.json$/);
      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();

      const written = mockWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config.mcpServers.playwright).toBeDefined();
    });

    it("writes strict startup for Arinova generated CLI config", () => {
      mockExistsSync.mockReturnValue(false);

      ensureCliMcpConfig(undefined, mockLogger as never, {
        botToken: "ari_test",
        serverUrl: "wss://chat.example.com",
      });

      const written = mockWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config.mcpServers.arinova.args).toContain("--strict-startup");
    });

    it("skips write when content unchanged", () => {
      const expectedConfig = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@0.0.68"] } } };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(expectedConfig, null, 2));

      ensureCliMcpConfig(undefined, mockLogger as never);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns undefined on error", () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error("perm denied");
      });
      const result = ensureCliMcpConfig(undefined, mockLogger as never);
      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("ensureCodexMcpServers", () => {
    it("calls execFileSync for each server", () => {
      ensureCodexMcpServers("codex", mockLogger as never);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1); // playwright only
      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args[0]).toBe("mcp");
      expect(args[1]).toBe("add");
      expect(args[2]).toBe("playwright");
      expect(args).toContain("--");
      expect(args).toContain("npx");
    });

    it("passes --strict-startup when registering Arinova with Codex", () => {
      ensureCodexMcpServers("codex", mockLogger as never, {
        botToken: "ari_test",
        serverUrl: "wss://chat.example.com",
      });

      const arinovaCall = mockExecFileSync.mock.calls.find((call) => (call[1] as string[])[2] === "arinova");
      expect(arinovaCall).toBeDefined();
      expect(arinovaCall![1] as string[]).toContain("--strict-startup");
    });

    it("can register Arinova for Codex without writing a global bot token", () => {
      ensureCodexMcpServers(
        "codex",
        mockLogger as never,
        {
          botToken: "ari_global",
          serverUrl: "wss://chat.example.com",
        },
        undefined,
        { arinovaAuth: "inherited" },
      );

      const arinovaCall = mockExecFileSync.mock.calls.find((call) => (call[1] as string[])[2] === "arinova");
      expect(arinovaCall).toBeDefined();
      const args = arinovaCall![1] as string[];
      expect(args).not.toContain("ARINOVA_BOT_TOKEN=ari_global");
      expect(args).toContain("--server-url");
      expect(args).toContain("wss://chat.example.com");
      expect(args).not.toContain("--token");
      expect(args).not.toContain("ari_global");
    });

    it("includes --env for github server", () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      ensureCodexMcpServers("codex", mockLogger as never);
      expect(mockExecFileSync).toHaveBeenCalledTimes(2); // playwright + github

      const githubCall = mockExecFileSync.mock.calls.find((call) => (call[1] as string[])[2] === "github");
      expect(githubCall).toBeDefined();
      const args = githubCall![1] as string[];
      expect(args).toContain("--env");
      expect(args).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=ghp_test");
    });

    it("logs error but continues on failure", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });
      ensureCodexMcpServers("codex", mockLogger as never);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("sets CODEX_HOME env when codexHome option is provided", () => {
      ensureCodexMcpServers("codex", mockLogger as never, undefined, undefined, {
        codexHome: "/tmp/agent-codex",
      });
      const opts = mockExecFileSync.mock.calls[0][2] as { env?: Record<string, string> };
      expect(opts.env?.CODEX_HOME).toBe("/tmp/agent-codex");
    });

    it("formats exec error with status, stdout, and stderr details", () => {
      const richError = Object.assign(new Error("exec failed"), {
        status: 1,
        signal: "SIGTERM",
        stdout: Buffer.from("some stdout"),
        stderr: Buffer.from("some stderr"),
      });
      mockExecFileSync.mockImplementation(() => {
        throw richError;
      });
      ensureCodexMcpServers("codex", mockLogger as never);
      const errorMsg = mockLogger.error.mock.calls[0][0] as string;
      expect(errorMsg).toContain("status=1");
      expect(errorMsg).toContain("signal=SIGTERM");
      expect(errorMsg).toContain("stdout=some stdout");
      expect(errorMsg).toContain("stderr=some stderr");
    });

    it("formats non-Error thrown value as string", () => {
      mockExecFileSync.mockImplementation(() => {
        throw "string-error";
      });
      ensureCodexMcpServers("codex", mockLogger as never);
      const errorMsg = mockLogger.error.mock.calls[0][0] as string;
      expect(errorMsg).toContain("string-error");
    });
  });

  describe("getPreinstalledMcpServers — user servers", () => {
    it("merges user-defined servers and allows overriding preinstalled ones", () => {
      const userServers = {
        playwright: { command: "custom-pw", args: ["--custom"] },
        myServer: { command: "my-cmd", args: ["--flag"] },
      };
      const servers = getPreinstalledMcpServers(undefined, userServers);
      expect(servers.playwright.command).toBe("custom-pw");
      expect(servers.myServer).toBeDefined();
      expect(servers.myServer.command).toBe("my-cmd");
    });
  });

  describe("ensureAgentCliMcpConfig", () => {
    function makeMockFs(): FileSystem {
      return {
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      };
    }

    it("generates a per-agent config file and returns its path", () => {
      const fs = makeMockFs();
      const result = ensureAgentCliMcpConfig(
        "agent-1",
        mockLogger as never,
        { botToken: "tok-1", serverUrl: "wss://chat.example.com" },
        undefined,
        fs,
      );

      expect(result).toMatch(/agent-1\.json$/);
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

      const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config.mcpServers.playwright).toBeDefined();
      expect(config.mcpServers.arinova).toBeDefined();
      expect(config.mcpServers.arinova.args).toContain("--strict-startup");
    });

    it("skips write when existing config content matches", () => {
      const fs = makeMockFs();
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

      // First call to discover what would be written
      const fs1 = makeMockFs();
      ensureAgentCliMcpConfig(
        "agent-2",
        mockLogger as never,
        { botToken: "tok-2", serverUrl: "wss://chat.example.com" },
        undefined,
        fs1,
      );
      const desired = (fs1.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;

      // Second call with matching existing content
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(desired);
      ensureAgentCliMcpConfig(
        "agent-2",
        mockLogger as never,
        { botToken: "tok-2", serverUrl: "wss://chat.example.com" },
        undefined,
        fs,
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("returns undefined and logs error on failure", () => {
      const fs = makeMockFs();
      (fs.mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("disk full");
      });

      const result = ensureAgentCliMcpConfig(
        "agent-fail",
        mockLogger as never,
        { botToken: "tok", serverUrl: "wss://x" },
        undefined,
        fs,
      );
      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("agent-fail"));
    });

    it("includes user servers in the generated config", () => {
      const fs = makeMockFs();
      const userServers = { custom: { command: "custom-cmd", args: ["--arg"] } };
      ensureAgentCliMcpConfig(
        "agent-custom",
        mockLogger as never,
        { botToken: "tok", serverUrl: "wss://x" },
        userServers,
        fs,
      );

      const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const config = JSON.parse(written);
      expect(config.mcpServers.custom).toBeDefined();
      expect(config.mcpServers.custom.command).toBe("custom-cmd");
    });
  });

  describe("ensureAgentCodexHome", () => {
    it("creates auth symlink and registers MCP servers", () => {
      // existsSync: first call for auth source -> true, second for target -> true
      mockExistsSync
        .mockReturnValueOnce(true) // sourceAuth exists
        .mockReturnValueOnce(true); // targetAuth exists
      mockLstatSync.mockReturnValue({} as never); // target exists (truthy)

      const result = ensureAgentCodexHome(
        "/usr/local/bin/codex",
        mockLogger as never,
        "/tmp/codex-agent-1",
        { botToken: "ari_tok", serverUrl: "wss://chat.example.com" },
        undefined,
        "/home/user/.codex",
      );

      expect(result).toBe("/tmp/codex-agent-1");
      expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/codex-agent-1", { recursive: true });
      expect(mockRmSync).toHaveBeenCalled();
      expect(mockSymlinkSync).toHaveBeenCalled();
      // Should also call execFileSync for MCP servers (playwright + arinova)
      expect(mockExecFileSync).toHaveBeenCalled();
    });

    it("warns and returns early when auth source does not exist", () => {
      mockExistsSync.mockReturnValue(false); // sourceAuth does not exist

      ensureAgentCodexHome(
        "/usr/local/bin/codex",
        mockLogger as never,
        "/tmp/codex-agent-2",
        { botToken: "ari_tok", serverUrl: "wss://chat.example.com" },
        undefined,
        "/nonexistent/.codex",
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("auth source not found"));
      expect(mockSymlinkSync).not.toHaveBeenCalled();
    });

    it("falls back to cpSync when symlinkSync fails", () => {
      mockExistsSync
        .mockReturnValueOnce(true) // sourceAuth exists
        .mockReturnValueOnce(false); // targetAuth does not exist
      mockLstatSync.mockReturnValue(undefined as never); // falsy

      mockSymlinkSync.mockImplementation(() => {
        throw new Error("symlink not supported");
      });

      ensureAgentCodexHome(
        "/usr/local/bin/codex",
        mockLogger as never,
        "/tmp/codex-agent-3",
        { botToken: "ari_tok", serverUrl: "wss://chat.example.com" },
        undefined,
        "/home/user/.codex",
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("copying instead"));
      expect(mockCpSync).toHaveBeenCalled();
    });

    it("passes codexHome to ensureCodexMcpServers via CODEX_HOME env", () => {
      mockExistsSync.mockReturnValue(false); // sourceAuth doesn't exist → early return from auth link

      ensureAgentCodexHome("/usr/local/bin/codex", mockLogger as never, "/tmp/codex-agent-4", {
        botToken: "ari_tok",
        serverUrl: "wss://chat.example.com",
      });

      // Check that execFileSync was called with CODEX_HOME in env
      const call = mockExecFileSync.mock.calls[0];
      const opts = call[2] as { env?: Record<string, string> };
      expect(opts.env?.CODEX_HOME).toBe("/tmp/codex-agent-4");
    });

    it("removes stale target before creating symlink when target exists via lstat", () => {
      mockExistsSync
        .mockReturnValueOnce(true) // sourceAuth exists
        .mockReturnValueOnce(false); // existsSync(targetAuth) = false (broken link)
      mockLstatSync.mockReturnValue({ isSymbolicLink: () => true } as never); // but lstat finds it

      ensureAgentCodexHome(
        "/usr/local/bin/codex",
        mockLogger as never,
        "/tmp/codex-agent-5",
        { botToken: "ari_tok", serverUrl: "wss://chat.example.com" },
        undefined,
        "/home/user/.codex",
      );

      expect(mockRmSync).toHaveBeenCalled();
      expect(mockSymlinkSync).toHaveBeenCalled();
    });
  });
});
