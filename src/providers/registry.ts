import type { Provider, ProviderId } from "./types.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../util/logger.js";
import { AnthropicCliProvider } from "./anthropic-cli.js";
import { AnthropicSdkProvider } from "./anthropic-sdk.js";
import { OpenAICliProvider } from "./openai-cli.js";

/**
 * Create all enabled providers from config.
 */
export function createProviders(
  config: BridgeConfig,
  logger: Logger,
): Map<ProviderId, Provider> {
  const providers = new Map<ProviderId, Provider>();

  // anthropic-api (SDK)
  const anthropicApi = config.providers["anthropic-api"];
  if (anthropicApi?.enabled && anthropicApi.apiKey) {
    try {
      providers.set(
        "anthropic-api",
        new AnthropicSdkProvider(
          {
            apiKey: anthropicApi.apiKey,
            defaultModel: anthropicApi.defaultModel,
            defaultCwd: config.defaults.cwd,
            maxSessions: config.defaults.maxSessions,
            idleTimeoutMs: config.defaults.idleTimeoutMs,
            mcpConfigPath: config.defaults.mcpConfigPath,
          },
          logger,
        ),
      );
      logger.info("registry: anthropic-api provider enabled");
    } catch (err) {
      logger.error(`registry: failed to create anthropic-api provider: ${err}`);
    }
  }

  // anthropic-oauth (CLI)
  const anthropicOauth = config.providers["anthropic-oauth"];
  if (anthropicOauth?.enabled) {
    try {
      providers.set(
        "anthropic-oauth",
        new AnthropicCliProvider(
          {
            claudePath: anthropicOauth.claudePath ?? "claude",
            mcpConfigPath: config.defaults.mcpConfigPath,
            defaultCwd: config.defaults.cwd,
            maxSessions: config.defaults.maxSessions,
            idleTimeoutMs: config.defaults.idleTimeoutMs,
          },
          logger,
        ),
      );
      logger.info("registry: anthropic-oauth provider enabled");
    } catch (err) {
      logger.error(`registry: failed to create anthropic-oauth provider: ${err}`);
    }
  }

  // openai-api (Codex CLI + API Key)
  const openaiApi = config.providers["openai-api"];
  if (openaiApi?.enabled) {
    try {
      providers.set(
        "openai-api",
        new OpenAICliProvider(
          {
            providerId: "openai-api",
            displayName: "OpenAI API (Codex CLI)",
            codexPath: openaiApi.codexPath,
            apiKey: openaiApi.apiKey,
            defaultCwd: config.defaults.cwd,
            dbPath: config.defaults.dbPath,
          },
          logger,
        ),
      );
      logger.info("registry: openai-api provider enabled");
    } catch (err) {
      logger.error(`registry: failed to create openai-api provider: ${err}`);
    }
  }

  // openai-oauth (Codex CLI + OAuth)
  const openaiOauth = config.providers["openai-oauth"];
  if (openaiOauth?.enabled) {
    try {
      providers.set(
        "openai-oauth",
        new OpenAICliProvider(
          {
            providerId: "openai-oauth",
            displayName: "OpenAI OAuth (Codex CLI)",
            codexPath: openaiOauth.codexPath,
            defaultCwd: config.defaults.cwd,
            dbPath: config.defaults.dbPath,
          },
          logger,
        ),
      );
      logger.info("registry: openai-oauth provider enabled");
    } catch (err) {
      logger.error(`registry: failed to create openai-oauth provider: ${err}`);
    }
  }

  return providers;
}
