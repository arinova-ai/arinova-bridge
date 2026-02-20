import type { Provider } from "./types.js";
import type { BridgeConfig } from "../config.js";
import type { ProviderEntry } from "../config-file.js";
import type { Logger } from "../util/logger.js";
import { AnthropicCliProvider } from "./anthropic-cli.js";
import { AnthropicSdkProvider } from "./anthropic-sdk.js";
import { OpenAICliProvider } from "./openai-cli.js";

/**
 * Map baseUrl/apiKey to the correct env var names based on provider type.
 */
function buildEnv(entry: ProviderEntry): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  let hasEnv = false;

  if (entry.type === "anthropic-cli") {
    if (entry.baseUrl) {
      env.ANTHROPIC_BASE_URL = entry.baseUrl;
      hasEnv = true;
    }
    if (entry.apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = entry.apiKey;
      hasEnv = true;
    }
  } else if (entry.type === "openai-cli") {
    if (entry.baseUrl) {
      env.OPENAI_BASE_URL = entry.baseUrl;
      hasEnv = true;
    }
    if (entry.apiKey) {
      env.OPENAI_API_KEY = entry.apiKey;
      hasEnv = true;
    }
  }

  return hasEnv ? env : undefined;
}

/**
 * Create all enabled providers from config.
 * Iterates the providers array and instantiates based on `type`.
 */
export function createProviders(
  config: BridgeConfig,
  logger: Logger,
): Map<string, Provider> {
  const providers = new Map<string, Provider>();

  for (const entry of config.providers) {
    if (!entry.enabled) continue;

    // Skip duplicate IDs
    if (providers.has(entry.id)) {
      logger.warn(`registry: duplicate provider id "${entry.id}", skipping`);
      continue;
    }

    try {
      const provider = createProvider(entry, config, logger);
      if (provider) {
        providers.set(entry.id, provider);
        logger.info(`registry: ${entry.id} (${entry.type}) provider enabled`);
      }
    } catch (err) {
      logger.error(`registry: failed to create ${entry.id} provider: ${err}`);
    }
  }

  return providers;
}

function createProvider(
  entry: ProviderEntry,
  config: BridgeConfig,
  logger: Logger,
): Provider | null {
  const env = buildEnv(entry);

  switch (entry.type) {
    case "anthropic-cli":
      return new AnthropicCliProvider(
        {
          providerId: entry.id,
          displayName: entry.displayName,
          claudePath: entry.claudePath ?? "claude",
          mcpConfigPath: config.defaults.mcpConfigPath,
          defaultCwd: config.defaults.cwd,
          maxSessions: config.defaults.maxSessions,
          idleTimeoutMs: config.defaults.idleTimeoutMs,
          env,
          models: entry.models,
        },
        logger,
      );

    case "anthropic-sdk":
      if (!entry.apiKey) {
        logger.error(`registry: ${entry.id} requires apiKey`);
        return null;
      }
      return new AnthropicSdkProvider(
        {
          providerId: entry.id,
          displayName: entry.displayName,
          apiKey: entry.apiKey,
          defaultModel: entry.defaultModel,
          defaultCwd: config.defaults.cwd,
          maxSessions: config.defaults.maxSessions,
          idleTimeoutMs: config.defaults.idleTimeoutMs,
          mcpConfigPath: config.defaults.mcpConfigPath,
          models: entry.models,
        },
        logger,
      );

    case "openai-cli":
      return new OpenAICliProvider(
        {
          providerId: entry.id,
          displayName: entry.displayName,
          codexPath: entry.codexPath,
          apiKey: entry.apiKey,
          defaultCwd: config.defaults.cwd,
          dbPath: config.defaults.dbPath,
          env,
          models: entry.models,
        },
        logger,
      );

    default:
      logger.error(`registry: unknown provider type "${entry.type}" for ${entry.id}`);
      return null;
  }
}
