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
    delete process.env.ARINOVA_SERVER_URL;
    delete process.env.ARINOVA_BOT_TOKEN;
    delete process.env.DEFAULT_PROVIDER;
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
    // No config file → empty providers array
    expect(config.providers).toEqual([]);
  });

  it("loads providers from config file array", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "openai-api",
      providers: [
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
        { id: "openai-api", type: "openai-cli", displayName: "OpenAI API", enabled: true, apiKey: "sk-test" },
      ],
      defaults: { cwd: "/home/test", maxSessions: 3 },
    });

    const config = loadConfig();

    expect(config.arinova.serverUrl).toBe("ws://file:3501");
    expect(config.defaultProvider).toBe("openai-api");
    expect(config.providers).toHaveLength(2);
    expect(config.providers[0].id).toBe("anthropic-oauth");
    expect(config.providers[1].id).toBe("openai-api");
    expect(config.providers[1].apiKey).toBe("sk-test");
    expect(config.defaults.cwd).toBe("/home/test");
    expect(config.defaults.maxSessions).toBe(3);
  });

  it("env vars override config file for non-provider fields", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "anthropic-oauth",
      providers: [
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
      ],
      defaults: { cwd: "/home/file" },
    });

    process.env.ARINOVA_SERVER_URL = "ws://env:3501";
    process.env.ARINOVA_BOT_TOKEN = "env-token";
    process.env.DEFAULT_CWD = "/home/env";
    process.env.DEFAULT_PROVIDER = "anthropic-api";

    const config = loadConfig();

    expect(config.arinova.serverUrl).toBe("ws://env:3501");
    expect(config.arinova.botToken).toBe("env-token");
    expect(config.defaultProvider).toBe("anthropic-api");
    expect(config.defaults.cwd).toBe("/home/env");
  });

  it("resolves ~ in cwd path", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_BOT_TOKEN = "test-token";
    process.env.DEFAULT_CWD = "~/projects";

    const config = loadConfig();
    expect(config.defaults.cwd).not.toContain("~");
    expect(config.defaults.cwd).toContain("projects");
  });
});
