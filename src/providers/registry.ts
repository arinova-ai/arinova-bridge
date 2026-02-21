import type { Provider } from "./types.js";
import type { BridgeConfig } from "../config.js";
import type { ProviderEntry } from "../config-file.js";
import type { Logger } from "../util/logger.js";
import { AnthropicCliProvider } from "./anthropic-cli.js";
import { AnthropicSdkProvider } from "./anthropic-sdk.js";
import { OpenAICliProvider } from "./openai-cli.js";
import { GeminiCliProvider } from "./gemini-cli.js";
import { readOAuthToken, writeOAuthToken, isTokenExpired } from "../oauth/token-store.js";
import { refreshAccessToken } from "../oauth/minimax.js";

/** Default model list for native Anthropic providers (no baseUrl = direct Anthropic). */
const DEFAULT_ANTHROPIC_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
];

/**
 * Map baseUrl/apiKey to the correct env var names based on provider type.
 * For OAuth providers (no apiKey), injects token from token store.
 */
async function buildEnv(entry: ProviderEntry, logger: Logger): Promise<Record<string, string> | undefined> {
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
    } else {
      // No apiKey — try OAuth token store
      const oauthToken = await resolveOAuthToken(entry.id, logger);
      if (oauthToken) {
        env.ANTHROPIC_AUTH_TOKEN = oauthToken;
        hasEnv = true;
      }
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
  } else if (entry.type === "gemini-cli") {
    if (entry.apiKey) {
      env.GEMINI_API_KEY = entry.apiKey;
      hasEnv = true;
    }
  }

  return hasEnv ? env : undefined;
}

/**
 * Read OAuth token for a provider, refreshing if expired.
 * Returns the access token string or null.
 */
async function resolveOAuthToken(providerId: string, logger: Logger): Promise<string | null> {
  const token = readOAuthToken(providerId);
  if (!token) return null;

  if (!isTokenExpired(token)) {
    return token.accessToken;
  }

  // Token is expiring/expired — try refresh
  logger.info(`registry: ${providerId} OAuth token expiring, refreshing...`);
  try {
    const refreshed = await refreshAccessToken(token.refreshToken);
    writeOAuthToken(providerId, refreshed);
    logger.info(`registry: ${providerId} OAuth token refreshed`);
    return refreshed.accessToken;
  } catch (err) {
    logger.error(`registry: ${providerId} OAuth token refresh failed: ${err}`);
    return null;
  }
}

/**
 * Create all enabled providers from config.
 * Iterates the providers array and instantiates based on `type`.
 */
export async function createProviders(
  config: BridgeConfig,
  logger: Logger,
): Promise<Map<string, Provider>> {
  const providers = new Map<string, Provider>();

  for (const entry of config.providers) {
    if (!entry.enabled) continue;

    // Skip duplicate IDs
    if (providers.has(entry.id)) {
      logger.warn(`registry: duplicate provider id "${entry.id}", skipping`);
      continue;
    }

    try {
      const provider = await createProvider(entry, config, logger);
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

async function createProvider(
  entry: ProviderEntry,
  config: BridgeConfig,
  logger: Logger,
): Promise<Provider | null> {
  const env = await buildEnv(entry, logger);

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
          models: entry.models ?? (!entry.baseUrl ? DEFAULT_ANTHROPIC_MODELS : undefined),
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

    case "gemini-cli":
      return new GeminiCliProvider(
        {
          providerId: entry.id,
          displayName: entry.displayName,
          geminiPath: entry.geminiPath,
          apiKey: entry.apiKey,
          defaultCwd: config.defaults.cwd,
          dbPath: config.defaults.dbPath,
          env,
          models: entry.models ?? [
            "gemini-3.1-pro-preview",
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
          ],
        },
        logger,
      );

    default:
      logger.error(`registry: unknown provider type "${entry.type}" for ${entry.id}`);
      return null;
  }
}
