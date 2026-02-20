import { homedir } from "node:os";
import path from "node:path";
import type { ProviderId } from "./providers/types.js";
import { readConfigFile } from "./config-file.js";

export interface BridgeConfig {
  arinova: {
    serverUrl: string;
    botToken: string;
  };
  defaultProvider: ProviderId;
  providers: {
    "anthropic-api"?: {
      enabled: boolean;
      apiKey?: string;
      defaultModel?: string;
    };
    "anthropic-oauth"?: {
      enabled: boolean;
      claudePath?: string;
    };
    "openai-api"?: {
      enabled: boolean;
      apiKey?: string;
      codexPath?: string;
    };
    "openai-oauth"?: {
      enabled: boolean;
      codexPath?: string;
    };
  };
  defaults: {
    cwd: string;
    maxSessions: number;
    idleTimeoutMs: number;
    dbPath: string;
    mcpConfigPath?: string;
  };
}

/**
 * Load config from JSON file + env var overrides.
 * Env vars always take highest priority.
 */
export function loadConfig(): BridgeConfig {
  const file = readConfigFile();

  const serverUrl =
    process.env.ARINOVA_SERVER_URL ??
    file?.arinova?.serverUrl ??
    "";
  const botToken =
    process.env.ARINOVA_BOT_TOKEN ??
    file?.arinova?.botToken ??
    "";

  if (!serverUrl) throw new Error("ARINOVA_SERVER_URL is required (env or config file)");
  if (!botToken) throw new Error("ARINOVA_BOT_TOKEN is required (env or config file)");

  const defaultProvider = (
    process.env.DEFAULT_PROVIDER ??
    file?.defaultProvider ??
    "anthropic-oauth"
  ) as ProviderId;

  // --- Provider configs ---
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY ??
    file?.providers?.["anthropic-api"]?.apiKey;

  const claudePath =
    process.env.CLAUDE_PATH ??
    file?.providers?.["anthropic-oauth"]?.claudePath ??
    "claude";

  const openaiApiKey =
    process.env.OPENAI_API_KEY ??
    file?.providers?.["openai-api"]?.apiKey;

  const codexPath =
    process.env.CODEX_BINARY_PATH ??
    file?.providers?.["openai-api"]?.codexPath ??
    file?.providers?.["openai-oauth"]?.codexPath;

  const defaultCwd =
    process.env.DEFAULT_CWD ??
    file?.defaults?.cwd ??
    path.join(homedir(), "projects");

  const maxSessions = parseInt(
    process.env.MAX_SESSIONS ?? String(file?.defaults?.maxSessions ?? 5),
    10,
  );

  const idleTimeoutMs = file?.defaults?.idleTimeoutMs ?? 600_000;

  const dbPath =
    process.env.DB_PATH ??
    file?.defaults?.dbPath ??
    path.join(homedir(), ".arinova-bridge", "bridge.db");

  const mcpConfigPath =
    process.env.MCP_CONFIG_PATH ?? undefined;

  // Determine which providers are enabled
  // If config file exists, use its enabled flags; otherwise enable based on available credentials
  const hasConfigFile = file !== null;

  return {
    arinova: { serverUrl, botToken },
    defaultProvider,
    providers: {
      "anthropic-api": {
        enabled: hasConfigFile
          ? file.providers?.["anthropic-api"]?.enabled ?? false
          : !!anthropicApiKey,
        apiKey: anthropicApiKey,
        defaultModel: file?.providers?.["anthropic-api"]?.defaultModel,
      },
      "anthropic-oauth": {
        enabled: hasConfigFile
          ? file.providers?.["anthropic-oauth"]?.enabled ?? false
          : true, // Default enabled since it just needs claude CLI
        claudePath,
      },
      "openai-api": {
        enabled: hasConfigFile
          ? file.providers?.["openai-api"]?.enabled ?? false
          : !!openaiApiKey,
        apiKey: openaiApiKey,
        codexPath,
      },
      "openai-oauth": {
        enabled: hasConfigFile
          ? file.providers?.["openai-oauth"]?.enabled ?? false
          : false,
        codexPath,
      },
    },
    defaults: {
      cwd: defaultCwd,
      maxSessions,
      idleTimeoutMs,
      dbPath,
      mcpConfigPath,
    },
  };
}
