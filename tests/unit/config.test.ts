import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock config-file before importing config
vi.mock("../../src/config-file.js", () => ({
  readConfigFile: vi.fn(),
}));

import { loadConfig } from "../../src/config.js";
import { readConfigFile } from "../../src/config-file.js";

const mockReadConfigFile = vi.mocked(readConfigFile);

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    // Clean up env vars
    delete process.env.ARINOVA_SERVER_URL;
    delete process.env.ARINOVA_BOT_TOKEN;
    delete process.env.DEFAULT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_PATH;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_BINARY_PATH;
    delete process.env.DEFAULT_CWD;
    delete process.env.MAX_SESSIONS;
    delete process.env.DB_PATH;
    delete process.env.MCP_CONFIG_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses default serverUrl when not configured", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_BOT_TOKEN = "test-token";
    const config = loadConfig();
    expect(config.arinova.serverUrl).toBe("wss://api.chat.arinova.ai");
  });

  it("throws if botToken is missing", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_SERVER_URL = "ws://test:3501";
    expect(() => loadConfig()).toThrow("ARINOVA_BOT_TOKEN is required");
  });

  it("loads from env vars only (no config file)", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_SERVER_URL = "ws://test:3501";
    process.env.ARINOVA_BOT_TOKEN = "test-token";
    process.env.DEFAULT_CWD = "/tmp/test";
    process.env.MAX_SESSIONS = "10";

    const config = loadConfig();

    expect(config.arinova.serverUrl).toBe("ws://test:3501");
    expect(config.arinova.botToken).toBe("test-token");
    expect(config.defaults.cwd).toBe("/tmp/test");
    expect(config.defaults.maxSessions).toBe(10);
    // No config file → anthropic-oauth enabled by default
    expect(config.providers["anthropic-oauth"]?.enabled).toBe(true);
  });

  it("loads from config file", () => {
    mockReadConfigFile.mockReturnValue({
      version: 1,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "openai-api",
      providers: {
        "anthropic-api": { enabled: true, apiKey: "sk-ant-test" },
        "anthropic-oauth": { enabled: false },
        "openai-api": { enabled: true, apiKey: "sk-test", codexPath: "/usr/bin/codex" },
      },
      defaults: { cwd: "/home/test", maxSessions: 3 },
    });

    const config = loadConfig();

    expect(config.arinova.serverUrl).toBe("ws://file:3501");
    expect(config.defaultProvider).toBe("openai-api");
    expect(config.providers["anthropic-api"]?.enabled).toBe(true);
    expect(config.providers["anthropic-api"]?.apiKey).toBe("sk-ant-test");
    expect(config.providers["anthropic-oauth"]?.enabled).toBe(false);
    expect(config.providers["openai-api"]?.enabled).toBe(true);
    expect(config.defaults.cwd).toBe("/home/test");
    expect(config.defaults.maxSessions).toBe(3);
  });

  it("env vars override config file", () => {
    mockReadConfigFile.mockReturnValue({
      version: 1,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "anthropic-oauth",
      providers: {
        "anthropic-api": { enabled: true, apiKey: "sk-ant-file" },
      },
      defaults: { cwd: "/home/file" },
    });

    process.env.ARINOVA_SERVER_URL = "ws://env:3501";
    process.env.ARINOVA_BOT_TOKEN = "env-token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    process.env.DEFAULT_CWD = "/home/env";
    process.env.DEFAULT_PROVIDER = "anthropic-api";

    const config = loadConfig();

    expect(config.arinova.serverUrl).toBe("ws://env:3501");
    expect(config.arinova.botToken).toBe("env-token");
    expect(config.defaultProvider).toBe("anthropic-api");
    expect(config.providers["anthropic-api"]?.apiKey).toBe("sk-ant-env");
    expect(config.defaults.cwd).toBe("/home/env");
  });

  it("enables providers based on credentials when no config file", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_SERVER_URL = "ws://test:3501";
    process.env.ARINOVA_BOT_TOKEN = "test-token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";

    const config = loadConfig();

    expect(config.providers["anthropic-api"]?.enabled).toBe(true);
    expect(config.providers["anthropic-oauth"]?.enabled).toBe(true);
    expect(config.providers["openai-api"]?.enabled).toBe(true);
    expect(config.providers["openai-oauth"]?.enabled).toBe(false);
  });
});
