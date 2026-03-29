import { homedir } from "node:os";
import path from "node:path";
import { readConfigFile, type ProviderEntry, type AgentEntry } from "./config-file.js";

export interface ResolvedAgent {
  name: string;
  botToken: string;
  provider: string;
  cwd: string;
  model?: string;
}

export interface BridgeConfig {
  arinova: {
    serverUrl: string;
    botToken: string;
    agentName: string;
  };
  defaultProvider: string;
  providers: ProviderEntry[];
  defaults: {
    cwd: string;
    maxSessions: number;
    idleTimeoutMs: number;
    dbPath: string;
    mcpConfigPath?: string;
  };
  agents: ResolvedAgent[];
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
    "wss://api.chat.arinova.ai";
  const botToken =
    process.env.ARINOVA_BOT_TOKEN ??
    file?.arinova?.botToken ??
    "";

  if (!botToken) throw new Error("ARINOVA_BOT_TOKEN is required (env or config file)");

  const agentName =
    process.env.ARINOVA_AGENT_NAME ??
    file?.arinova?.agentName ??
    "default";

  const defaultProvider =
    process.env.DEFAULT_PROVIDER ??
    file?.defaultProvider ??
    "anthropic-oauth";

  const rawCwd =
    process.env.DEFAULT_CWD ??
    file?.defaults?.cwd ??
    path.join(homedir(), "projects");
  const defaultCwd = rawCwd.replace(/^~/, homedir());

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
    process.env.MCP_CONFIG_PATH ??
    file?.defaults?.mcpConfigPath ??
    undefined;

  // Read providers from config file array
  const providers: ProviderEntry[] = file?.providers ?? [];

  // Build agents list: use config agents array if present, else single agent fallback
  let agents: ResolvedAgent[];
  if (file?.agents && file.agents.length > 0) {
    agents = file.agents.map((a) => ({
      name: a.name,
      botToken: a.botToken,
      provider: a.provider,
      cwd: (a.cwd ?? defaultCwd).replace(/^~/, homedir()),
      model: a.model,
    }));
  } else {
    // Backward compatible: single agent from arinova.botToken
    agents = [{
      name: agentName,
      botToken,
      provider: defaultProvider,
      cwd: defaultCwd,
    }];
  }

  return {
    arinova: { serverUrl, botToken, agentName },
    defaultProvider,
    providers,
    defaults: {
      cwd: defaultCwd,
      maxSessions,
      idleTimeoutMs,
      dbPath,
      mcpConfigPath,
    },
    agents,
  };
}
