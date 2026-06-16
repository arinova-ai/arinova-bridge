import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = path.join(homedir(), ".arinova-bridge");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface ProviderEntry {
  id: string;
  type: string;
  displayName: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  claudePath?: string;
  codexPath?: string;
  configDir?: string;
  defaultModel?: string;
  models?: string[];
}

export interface AgentEntry {
  name: string;
  botToken: string;
  provider: string;
  cwd?: string;
  model?: string;
  /** Model used for compact summarisation (cheaper/faster model). */
  compactModel?: string;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ConfigFile {
  version: number;
  arinova: {
    serverUrl?: string;
    botToken: string;
    agentName?: string;
  };
  defaultProvider: string;
  providers: ProviderEntry[];
  defaults: {
    cwd?: string;
    maxSessions?: number;
    idleTimeoutMs?: number;
    dbPath?: string;
    mcpConfigPath?: string;
  };
  mcpServers?: Record<string, McpServerEntry>;
  agents?: AgentEntry[];
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function resolveProviderConfigDir(configDir: string | undefined): string | undefined {
  return configDir?.replace(/^~/, homedir());
}

export function readConfigFile(): ConfigFile | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return null;
  }
}

export function writeConfigFile(config: ConfigFile): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  // `mode` above only applies when the file is created. Explicitly chmod so
  // already-persisted plaintext config files (containing bot tokens) get their
  // permissions tightened too. Aligns with src/oauth/token-store.ts.
  fs.chmodSync(CONFIG_FILE, 0o600);
}
