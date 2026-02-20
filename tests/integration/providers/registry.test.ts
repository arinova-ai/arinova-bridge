import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all provider constructors using function keyword (not arrow) for new
vi.mock("../../../src/providers/anthropic-cli.js", () => ({
  AnthropicCliProvider: vi.fn(function (this: any, config: any) {
    this.id = config.providerId;
    this.type = "anthropic-cli";
    this.displayName = config.displayName;
    this.shutdown = vi.fn(async () => {});
  }),
}));

vi.mock("../../../src/providers/anthropic-sdk.js", () => ({
  AnthropicSdkProvider: vi.fn(function (this: any, config: any) {
    this.id = config.providerId;
    this.type = "anthropic-sdk";
    this.displayName = config.displayName;
    this.shutdown = vi.fn(async () => {});
  }),
}));

vi.mock("../../../src/providers/openai-cli.js", () => ({
  OpenAICliProvider: vi.fn(function (this: any, config: any) {
    this.id = config.providerId;
    this.type = "openai-cli";
    this.displayName = config.displayName;
    this.shutdown = vi.fn(async () => {});
  }),
}));

// Mock OAuth token store
vi.mock("../../../src/oauth/token-store.js", () => ({
  readOAuthToken: vi.fn(() => null),
  writeOAuthToken: vi.fn(),
  isTokenExpired: vi.fn(() => false),
}));

// Mock MiniMax OAuth (prevent real network calls)
vi.mock("../../../src/oauth/minimax.js", () => ({
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "new-rt",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })),
}));

import { createProviders } from "../../../src/providers/registry.js";
import { readOAuthToken, isTokenExpired } from "../../../src/oauth/token-store.js";
import type { BridgeConfig } from "../../../src/config.js";
import type { ProviderEntry } from "../../../src/config-file.js";

const mockReadOAuthToken = vi.mocked(readOAuthToken);
const mockIsTokenExpired = vi.mocked(isTokenExpired);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createConfig(providers: ProviderEntry[] = []): BridgeConfig {
  return {
    arinova: { serverUrl: "ws://test", botToken: "tok" },
    defaultProvider: "anthropic-oauth",
    providers,
    defaults: {
      cwd: "/default",
      maxSessions: 5,
      idleTimeoutMs: 600_000,
      dbPath: "/tmp/test.db",
    },
  };
}

describe("createProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadOAuthToken.mockReturnValue(null);
    mockIsTokenExpired.mockReturnValue(false);
  });

  it("returns empty map when no providers are configured", async () => {
    const providers = await createProviders(createConfig(), logger);
    expect(providers.size).toBe(0);
  });

  it("returns empty map when all providers are disabled", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: false },
      ]),
      logger,
    );
    expect(providers.size).toBe(0);
  });

  it("creates anthropic-cli provider when enabled", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("anthropic-oauth")).toBe(true);
    expect(providers.get("anthropic-oauth")!.id).toBe("anthropic-oauth");
    expect(providers.get("anthropic-oauth")!.type).toBe("anthropic-cli");
  });

  it("creates anthropic-sdk provider when enabled with API key", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "anthropic-api", type: "anthropic-sdk", displayName: "Anthropic API", enabled: true, apiKey: "sk-ant-test" },
      ]),
      logger,
    );
    expect(providers.has("anthropic-api")).toBe(true);
  });

  it("skips anthropic-sdk when enabled but no API key", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "anthropic-api", type: "anthropic-sdk", displayName: "Anthropic API", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("anthropic-api")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("requires apiKey"));
  });

  it("creates openai-cli provider when enabled", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "openai-api", type: "openai-cli", displayName: "OpenAI API", enabled: true, apiKey: "sk-test" },
      ]),
      logger,
    );
    expect(providers.has("openai-api")).toBe(true);
  });

  it("creates openai-cli provider without API key (OAuth mode)", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "openai-oauth", type: "openai-cli", displayName: "OpenAI OAuth", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("openai-oauth")).toBe(true);
  });

  it("creates multiple providers from array", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
        { id: "openai-api", type: "openai-cli", displayName: "OpenAI API", enabled: true, apiKey: "sk-test" },
      ]),
      logger,
    );
    expect(providers.size).toBe(2);
    expect(providers.has("anthropic-oauth")).toBe(true);
    expect(providers.has("openai-api")).toBe(true);
  });

  it("creates provider with custom baseUrl and apiKey (e.g. MiniMax)", async () => {
    const providers = await createProviders(
      createConfig([
        {
          id: "minimax-api",
          type: "anthropic-cli",
          displayName: "MiniMax API",
          enabled: true,
          apiKey: "sk-mm",
          baseUrl: "https://api.minimax.io/anthropic",
          models: ["MiniMax-M2.5", "MiniMax-M2.1"],
        },
      ]),
      logger,
    );
    expect(providers.has("minimax-api")).toBe(true);
    expect(providers.get("minimax-api")!.id).toBe("minimax-api");
  });

  it("creates provider with custom baseUrl and apiKey (e.g. Zhipu)", async () => {
    const providers = await createProviders(
      createConfig([
        {
          id: "zhipu-api",
          type: "anthropic-cli",
          displayName: "Zhipu API",
          enabled: true,
          apiKey: "sk-zhipu",
          baseUrl: "https://api.z.ai/api/anthropic",
          models: ["GLM-4.7", "GLM-4.5-Air", "GLM-5"],
        },
      ]),
      logger,
    );
    expect(providers.has("zhipu-api")).toBe(true);
    expect(providers.get("zhipu-api")!.id).toBe("zhipu-api");
  });

  it("skips duplicate provider IDs", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth Dup", enabled: true },
      ]),
      logger,
    );
    expect(providers.size).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("duplicate"));
  });

  it("skips unknown provider types", async () => {
    const providers = await createProviders(
      createConfig([
        { id: "unknown-provider", type: "unknown-type", displayName: "Unknown", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("unknown-provider")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("unknown provider type"));
  });

  it("logs when providers are created", async () => {
    await createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
      ]),
      logger,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("anthropic-oauth"),
    );
  });

  it("injects OAuth token for anthropic-cli provider without apiKey", async () => {
    mockReadOAuthToken.mockReturnValue({
      accessToken: "oauth-access-token",
      refreshToken: "oauth-refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const providers = await createProviders(
      createConfig([
        {
          id: "minimax-oauth",
          type: "anthropic-cli",
          displayName: "MiniMax OAuth",
          enabled: true,
          baseUrl: "https://api.minimax.io/anthropic",
        },
      ]),
      logger,
    );

    expect(providers.has("minimax-oauth")).toBe(true);
    expect(mockReadOAuthToken).toHaveBeenCalledWith("minimax-oauth");
  });

  it("refreshes expired OAuth token at startup", async () => {
    mockReadOAuthToken.mockReturnValue({
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: Math.floor(Date.now() / 1000) - 100,
    });
    mockIsTokenExpired.mockReturnValue(true);

    const providers = await createProviders(
      createConfig([
        {
          id: "minimax-oauth",
          type: "anthropic-cli",
          displayName: "MiniMax OAuth",
          enabled: true,
          baseUrl: "https://api.minimax.io/anthropic",
        },
      ]),
      logger,
    );

    expect(providers.has("minimax-oauth")).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("refreshed"));
  });
});
