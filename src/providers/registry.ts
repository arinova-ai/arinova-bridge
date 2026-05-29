import type { Provider } from "./types.js";
import type { BridgeConfig } from "../config.js";
import { resolveProviderConfigDir, type ProviderEntry } from "../config-file.js";
import type { Logger } from "../util/logger.js";
import { AnthropicCliProvider } from "./anthropic-cli.js";
import { AnthropicSdkProvider } from "./anthropic-sdk.js";
import { OpenAICliProvider } from "./openai-cli.js";
import { readOAuthToken, writeOAuthToken, isTokenExpired } from "../oauth/token-store.js";
import { refreshAccessToken } from "../oauth/minimax.js";
import {
  ensureCliMcpConfig,
  getPreinstalledMcpServers,
  ensureCodexMcpServers,
  type ArinovaMcpEnv,
} from "../mcp/preinstalled.js";

/** Default model list for native Anthropic providers (no baseUrl = direct Anthropic). */
const DEFAULT_ANTHROPIC_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];

/**
 * Map baseUrl/apiKey to the correct env var names based on provider type.
 * For OAuth providers (no apiKey), injects token from token store.
 */
async function buildEnv(entry: ProviderEntry, logger: Logger): Promise<Record<string, string> | undefined> {
  const env: Record<string, string> = {};
  let hasEnv = false;
  const configDir = resolveProviderConfigDir(entry.configDir);

  if (entry.type === "anthropic-cli") {
    if (configDir) {
      env.CLAUDE_CONFIG_DIR = configDir;
      hasEnv = true;
    }
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
    if (configDir) {
      env.CODEX_HOME = configDir;
      hasEnv = true;
    }
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
export async function createProviders(config: BridgeConfig, logger: Logger): Promise<Map<string, Provider>> {
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

async function createProvider(entry: ProviderEntry, config: BridgeConfig, logger: Logger): Promise<Provider | null> {
  const env = await buildEnv(entry, logger);
  const configDir = resolveProviderConfigDir(entry.configDir);
  const arinovaMcp: ArinovaMcpEnv = {
    botToken: config.arinova.botToken,
    serverUrl: config.arinova.serverUrl,
  };
  const userMcp = Object.keys(config.mcpServers).length > 0 ? config.mcpServers : undefined;

  switch (entry.type) {
    case "anthropic-cli":
      return new AnthropicCliProvider(
        {
          providerId: entry.id,
          displayName: entry.displayName,
          claudePath: entry.claudePath ?? "claude",
          mcpConfigPath: ensureCliMcpConfig(config.defaults.mcpConfigPath, logger, arinovaMcp, userMcp),
          defaultCwd: config.defaults.cwd,
          maxSessions: config.defaults.maxSessions,
          idleTimeoutMs: config.defaults.idleTimeoutMs,
          env,
          models: entry.models ?? (!entry.baseUrl ? DEFAULT_ANTHROPIC_MODELS : undefined),
          configDir,
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
          mcpServers: getPreinstalledMcpServers(arinovaMcp, userMcp),
          models: entry.models,
        },
        logger,
      );

    case "openai-cli": {
      const codexPath = entry.codexPath ?? "codex";
      ensureCodexMcpServers(codexPath, logger, arinovaMcp, userMcp, {
        // Global Codex MCP config must not contain an agent token. OpenAI
        // agents receive tokened MCP config through per-agent CODEX_HOME.
        arinovaAuth: "inherited",
        ...(configDir ? { codexHome: configDir } : {}),
      });
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
          userMcp,
          configDir,
        },
        logger,
      );
    }

    default:
      logger.error(`registry: unknown provider type "${entry.type}" for ${entry.id}`);
      return null;
  }
}
