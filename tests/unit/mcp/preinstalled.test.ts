import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import {
  getPreinstalledMcpServers,
  ensureCliMcpConfig,
  ensureCodexMcpServers,
  ensureGeminiMcpServers,
} from "../../../src/mcp/preinstalled.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExecFileSync = vi.mocked(execFileSync);

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
      mockMkdirSync.mockImplementation(() => { throw new Error("perm denied"); });
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

      const arinovaCall = mockExecFileSync.mock.calls.find(
        (call) => (call[1] as string[])[2] === "arinova",
      );
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

      const arinovaCall = mockExecFileSync.mock.calls.find(
        (call) => (call[1] as string[])[2] === "arinova",
      );
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

      const githubCall = mockExecFileSync.mock.calls.find(
        (call) => (call[1] as string[])[2] === "github",
      );
      expect(githubCall).toBeDefined();
      const args = githubCall![1] as string[];
      expect(args).toContain("--env");
      expect(args).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=ghp_test");
    });

    it("logs error but continues on failure", () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
      ensureCodexMcpServers("codex", mockLogger as never);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("ensureGeminiMcpServers", () => {
    it("calls execFileSync for each server", () => {
      ensureGeminiMcpServers("gemini", mockLogger as never);
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args[0]).toBe("mcp");
      expect(args[1]).toBe("add");
      expect(args[2]).toBe("playwright");
      expect(args).toContain("--scope");
      expect(args).toContain("user");
      expect(args).toContain("--trust");
    });

    it("includes -e for github server env vars", () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      ensureGeminiMcpServers("gemini", mockLogger as never);

      const githubCall = mockExecFileSync.mock.calls.find(
        (call) => (call[1] as string[])[2] === "github",
      );
      expect(githubCall).toBeDefined();
      const args = githubCall![1] as string[];
      expect(args).toContain("-e");
      expect(args).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=ghp_test");
    });

    it("can register Arinova for Gemini without writing a global bot token", () => {
      ensureGeminiMcpServers(
        "gemini",
        mockLogger as never,
        {
          botToken: "ari_global",
          serverUrl: "wss://chat.example.com",
        },
        undefined,
        { arinovaAuth: "inherited" },
      );

      const arinovaCall = mockExecFileSync.mock.calls.find(
        (call) => (call[1] as string[])[2] === "arinova",
      );
      expect(arinovaCall).toBeDefined();
      const args = arinovaCall![1] as string[];
      expect(args).not.toContain("ARINOVA_BOT_TOKEN=ari_global");
      expect(args).toContain("--server-url");
      expect(args).toContain("wss://chat.example.com");
      expect(args).not.toContain("--token");
      expect(args).not.toContain("ari_global");
    });

    it("logs error but continues on failure", () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("auth error"); });
      ensureGeminiMcpServers("gemini", mockLogger as never);
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
