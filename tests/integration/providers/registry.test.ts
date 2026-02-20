import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all provider constructors using function keyword (not arrow) for new
vi.mock("../../../src/providers/anthropic-cli.js", () => ({
  AnthropicCliProvider: vi.fn(function (this: any) {
    this.id = "anthropic-oauth";
    this.displayName = "Anthropic OAuth (Claude CLI)";
    this.shutdown = vi.fn(async () => {});
  }),
}));

vi.mock("../../../src/providers/anthropic-sdk.js", () => ({
  AnthropicSdkProvider: vi.fn(function (this: any) {
    this.id = "anthropic-api";
    this.displayName = "Anthropic API (Claude Code SDK)";
    this.shutdown = vi.fn(async () => {});
  }),
}));

vi.mock("../../../src/providers/openai-cli.js", () => ({
  OpenAICliProvider: vi.fn(function (this: any, config: any) {
    this.id = config.providerId;
    this.displayName = config.displayName;
    this.shutdown = vi.fn(async () => {});
  }),
}));

import { createProviders } from "../../../src/providers/registry.js";
import type { BridgeConfig } from "../../../src/config.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createConfig(providerOverrides: BridgeConfig["providers"] = {}): BridgeConfig {
  return {
    arinova: { serverUrl: "ws://test", botToken: "tok" },
    defaultProvider: "anthropic-oauth",
    providers: {
      "anthropic-api": { enabled: false },
      "anthropic-oauth": { enabled: false },
      "openai-api": { enabled: false },
      "openai-oauth": { enabled: false },
      ...providerOverrides,
    },
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

  it("returns empty map when no providers are enabled", () => {
    const providers = createProviders(createConfig(), logger);
    expect(providers.size).toBe(0);
  });

  it("creates anthropic-oauth provider when enabled", () => {
    const providers = createProviders(
      createConfig({ "anthropic-oauth": { enabled: true, claudePath: "claude" } }),
      logger,
    );
    expect(providers.has("anthropic-oauth")).toBe(true);
    expect(providers.get("anthropic-oauth")!.id).toBe("anthropic-oauth");
  });

  it("creates anthropic-api provider when enabled with API key", () => {
    const providers = createProviders(
      createConfig({ "anthropic-api": { enabled: true, apiKey: "sk-ant-test" } }),
      logger,
    );
    expect(providers.has("anthropic-api")).toBe(true);
  });

  it("skips anthropic-api when enabled but no API key", () => {
    const providers = createProviders(
      createConfig({ "anthropic-api": { enabled: true } }),
      logger,
    );
    expect(providers.has("anthropic-api")).toBe(false);
  });

  it("creates openai-api provider when enabled", () => {
    const providers = createProviders(
      createConfig({ "openai-api": { enabled: true, apiKey: "sk-test" } }),
      logger,
    );
    expect(providers.has("openai-api")).toBe(true);
  });

  it("creates openai-oauth provider when enabled", () => {
    const providers = createProviders(
      createConfig({ "openai-oauth": { enabled: true } }),
      logger,
    );
    expect(providers.has("openai-oauth")).toBe(true);
  });

  it("creates multiple providers", () => {
    const providers = createProviders(
      createConfig({
        "anthropic-oauth": { enabled: true },
        "openai-api": { enabled: true, apiKey: "sk-test" },
      }),
      logger,
    );
    expect(providers.size).toBe(2);
    expect(providers.has("anthropic-oauth")).toBe(true);
    expect(providers.has("openai-api")).toBe(true);
  });

  it("logs when providers are created", () => {
    createProviders(
      createConfig({ "anthropic-oauth": { enabled: true } }),
      logger,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("anthropic-oauth"),
    );
  });
});
