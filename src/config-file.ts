import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = path.join(homedir(), ".arinova-bridge");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface ConfigFile {
  version: number;
  arinova: {
    serverUrl: string;
    botToken: string;
  };
  defaultProvider: string;
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
    cwd?: string;
    maxSessions?: number;
    idleTimeoutMs?: number;
    dbPath?: string;
  };
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
