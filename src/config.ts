import { homedir } from "node:os";
import path from "node:path";
import { readConfigFile, type ProviderEntry, type AgentEntry, type McpServerEntry } from "./config-file.js";
import { loadAgentPrompts, buildAgentSystemPrompt } from "./agents/loader.js";
import { validateEffort } from "./util/effort.js";

export interface ResolvedAgent {
  name: string;
  botToken: string;
  provider: string;
  cwd: string;
  model?: string;
  /** Model used for compact summarisation (cheaper/faster). */
  compactModel?: string;
  systemPrompt?: string;
  /** Canonical reasoning-effort level (resolved per-provider at send time). */
  effort?: string;
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
    effort?: string;
  };
  mcpServers: Record<string, McpServerEntry>;
  agents: ResolvedAgent[];
}

function readPositiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
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

  const maxSessions = readPositiveInteger(
    process.env.MAX_SESSIONS ?? file?.defaults?.maxSessions,
    5,
    "MAX_SESSIONS",
  );

  const idleTimeoutMs = readPositiveInteger(
    file?.defaults?.idleTimeoutMs,
    3_600_000,
    "defaults.idleTimeoutMs",
  );

  const dbPath =
    process.env.DB_PATH ??
    file?.defaults?.dbPath ??
    path.join(homedir(), ".arinova-bridge", "bridge.db");

  const mcpConfigPath =
    process.env.MCP_CONFIG_PATH ??
    file?.defaults?.mcpConfigPath ??
    undefined;

  const defaultEffort = validateEffort(file?.defaults?.effort, "defaults.effort");

  // Read providers from config file array
  const providers: ProviderEntry[] = file?.providers ?? [];

  // User-defined MCP servers from config
  const mcpServers: Record<string, McpServerEntry> = file?.mcpServers ?? {};

  // Load agent prompt files from ~/.arinova-bridge/agents/*.md
  const agentPrompts = loadAgentPrompts();

  // Build agents list: use config agents array if present, else single agent fallback
  let agents: ResolvedAgent[];
  if (file?.agents && file.agents.length > 0) {
    agents = file.agents.map((a) => ({
      name: a.name,
      botToken: a.botToken,
      provider: a.provider,
      cwd: (a.cwd ?? defaultCwd).replace(/^~/, homedir()),
      model: a.model,
      compactModel: a.compactModel ?? defaultCompactModel(a.provider),
      systemPrompt: buildAgentSystemPrompt(a.name, agentPrompts) || undefined,
      effort: validateEffort(a.effort, `agents[${a.name}].effort`) ?? defaultEffort,
    }));
  } else {
    // Backward compatible: single agent from arinova.botToken
    agents = [{
      name: agentName,
      botToken,
      provider: defaultProvider,
      cwd: defaultCwd,
      compactModel: defaultCompactModel(defaultProvider),
      systemPrompt: buildAgentSystemPrompt(agentName, agentPrompts) || undefined,
      effort: defaultEffort,
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
      effort: defaultEffort,
    },
    mcpServers,
    agents,
  };
}

/** Pick a cheap/fast compact model based on provider type. */
function defaultCompactModel(provider: string): string {
  if (provider.startsWith("anthropic")) return "claude-haiku-4-5";
  if (provider === "openai-cli") return "gpt-5.4-mini";
  if (provider === "openai-oauth") return "gpt-5.4-mini";
  if (provider === "openai-api") return "gpt-4.1-mini";
  return "claude-haiku-4-5";
}
