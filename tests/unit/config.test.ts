import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock config-file before importing config
vi.mock("../../src/config-file.js", () => ({
  readConfigFile: vi.fn(),
  getConfigDir: vi.fn(() => "/tmp/arinova-bridge-test-config"),
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

  it("rejects invalid MAX_SESSIONS env values", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_BOT_TOKEN = "test-token";

    for (const value of ["NaN", "0", "-1", "1.5"]) {
      process.env.MAX_SESSIONS = value;
      expect(() => loadConfig()).toThrow("MAX_SESSIONS must be a positive integer");
    }
  });

  it("falls back to default maxSessions when env and config omit it", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_BOT_TOKEN = "test-token";

    const config = loadConfig();

    expect(config.defaults.maxSessions).toBe(5);
  });

  it("rejects invalid idleTimeoutMs config values", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "anthropic-oauth",
      providers: [],
      defaults: { cwd: "/home/test", idleTimeoutMs: 0 },
    });

    expect(() => loadConfig()).toThrow("defaults.idleTimeoutMs must be a positive integer");
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
      providers: [{ id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true }],
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

  it("defaults openai-cli compact model to gpt-5.4-mini", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "openai-cli",
      providers: [],
      defaults: { cwd: "/home/test" },
      agents: [{ name: "bot", botToken: "bot-token", provider: "openai-cli" }],
    });

    const config = loadConfig();
    expect(config.agents[0].compactModel).toBe("gpt-5.4-mini");
  });

  it("defaults unknown provider compact model to claude-haiku-4-5", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "custom-llm",
      providers: [],
      defaults: { cwd: "/home/test" },
      agents: [{ name: "bot", botToken: "bot-token", provider: "custom-llm" }],
    });

    const config = loadConfig();
    expect(config.agents[0].compactModel).toBe("claude-haiku-4-5");
  });

  it("auto-injects anthropic-cli provider for obt_* token with no config", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_BOT_TOKEN = "obt_abc123def456";

    const config = loadConfig();

    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].id).toBe("anthropic-oauth");
    expect(config.providers[0].type).toBe("anthropic-cli");
    expect(config.providers[0].enabled).toBe(true);
  });

  it("does not inject provider for obt_* token when providers exist", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "anthropic-oauth",
      providers: [{ id: "anthropic-oauth", type: "anthropic-cli", displayName: "Existing", enabled: true }],
      defaults: { cwd: "/home/test" },
    });
    process.env.ARINOVA_BOT_TOKEN = "obt_abc123def456";

    const config = loadConfig();

    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].displayName).toBe("Existing");
  });

  it("does not inject provider for ari_* token with no config", () => {
    mockReadConfigFile.mockReturnValue(null);
    process.env.ARINOVA_BOT_TOKEN = "ari_permanent_token";

    const config = loadConfig();

    expect(config.providers).toEqual([]);
  });

  it("defaults openai-oauth compact model to gpt-5.4-mini", () => {
    mockReadConfigFile.mockReturnValue({
      version: 2,
      arinova: { serverUrl: "ws://file:3501", botToken: "file-token" },
      defaultProvider: "openai-oauth",
      providers: [{ id: "openai-oauth", type: "openai-cli", displayName: "OpenAI OAuth", enabled: true }],
      defaults: { cwd: "/home/test" },
      agents: [{ name: "casey", botToken: "casey-token", provider: "openai-oauth" }],
    });

    const config = loadConfig();

    expect(config.agents[0].compactModel).toBe("gpt-5.4-mini");
  });
});
