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

import { createProviders } from "../../../src/providers/registry.js";
import type { BridgeConfig } from "../../../src/config.js";
import type { ProviderEntry } from "../../../src/config-file.js";

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
  });

  it("returns empty map when no providers are configured", () => {
    const providers = createProviders(createConfig(), logger);
    expect(providers.size).toBe(0);
  });

  it("returns empty map when all providers are disabled", () => {
    const providers = createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: false },
      ]),
      logger,
    );
    expect(providers.size).toBe(0);
  });

  it("creates anthropic-cli provider when enabled", () => {
    const providers = createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("anthropic-oauth")).toBe(true);
    expect(providers.get("anthropic-oauth")!.id).toBe("anthropic-oauth");
    expect(providers.get("anthropic-oauth")!.type).toBe("anthropic-cli");
  });

  it("creates anthropic-sdk provider when enabled with API key", () => {
    const providers = createProviders(
      createConfig([
        { id: "anthropic-api", type: "anthropic-sdk", displayName: "Anthropic API", enabled: true, apiKey: "sk-ant-test" },
      ]),
      logger,
    );
    expect(providers.has("anthropic-api")).toBe(true);
  });

  it("skips anthropic-sdk when enabled but no API key", () => {
    const providers = createProviders(
      createConfig([
        { id: "anthropic-api", type: "anthropic-sdk", displayName: "Anthropic API", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("anthropic-api")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("requires apiKey"));
  });

  it("creates openai-cli provider when enabled", () => {
    const providers = createProviders(
      createConfig([
        { id: "openai-api", type: "openai-cli", displayName: "OpenAI API", enabled: true, apiKey: "sk-test" },
      ]),
      logger,
    );
    expect(providers.has("openai-api")).toBe(true);
  });

  it("creates openai-cli provider without API key (OAuth mode)", () => {
    const providers = createProviders(
      createConfig([
        { id: "openai-oauth", type: "openai-cli", displayName: "OpenAI OAuth", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("openai-oauth")).toBe(true);
  });

  it("creates multiple providers from array", () => {
    const providers = createProviders(
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

  it("creates provider with custom baseUrl and apiKey (e.g. MiniMax)", () => {
    const providers = createProviders(
      createConfig([
        {
          id: "minimax",
          type: "anthropic-cli",
          displayName: "MiniMax",
          enabled: true,
          apiKey: "sk-mm",
          baseUrl: "https://api.minimax.io/anthropic",
          models: ["MiniMax-M2.5", "MiniMax-M2.1"],
        },
      ]),
      logger,
    );
    expect(providers.has("minimax")).toBe(true);
    expect(providers.get("minimax")!.id).toBe("minimax");
  });

  it("skips duplicate provider IDs", () => {
    const providers = createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth Dup", enabled: true },
      ]),
      logger,
    );
    expect(providers.size).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("duplicate"));
  });

  it("skips unknown provider types", () => {
    const providers = createProviders(
      createConfig([
        { id: "unknown-provider", type: "unknown-type", displayName: "Unknown", enabled: true },
      ]),
      logger,
    );
    expect(providers.has("unknown-provider")).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("unknown provider type"));
  });

  it("logs when providers are created", () => {
    createProviders(
      createConfig([
        { id: "anthropic-oauth", type: "anthropic-cli", displayName: "Anthropic OAuth", enabled: true },
      ]),
      logger,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("anthropic-oauth"),
    );
  });
});
