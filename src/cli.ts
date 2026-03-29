#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const VERSION = "0.0.1";
const PID_FILE = path.join(homedir(), ".arinova-bridge", "bridge.pid");

function showHelp(): void {
  console.log(`
arinova-bridge v${VERSION}
Multi-provider bridge between Arinova Chat and AI coding assistants.

INSTALL
  npm install -g @arinova-ai/arinova-bridge

QUICK START
  arinova-bridge setup          # Interactive config wizard
  arinova-bridge start          # Start the bridge server

COMMANDS
  start    Start the bridge server (writes PID to ~/.arinova-bridge/bridge.pid)
  stop     Stop the running bridge server (sends SIGTERM via PID file)
  config   Show current configuration (secrets masked)
  setup    Interactive setup wizard (providers, bot token, statusLine)
  help     Show this help message

CONFIG FILE
  ~/.arinova-bridge/config.json

  {
    "version": 2,
    "arinova": {
      "serverUrl": "wss://api.chat.arinova.ai",
      "botToken": "ari_...",
      "agentName": "default"
    },
    "defaultProvider": "anthropic-oauth",
    "providers": [
      { "id": "anthropic-oauth", "type": "anthropic-cli", "displayName": "...", "enabled": true }
    ],
    "defaults": {
      "cwd": "~/projects",
      "maxSessions": 5,
      "idleTimeoutMs": 600000,
      "mcpConfigPath": null
    }
  }

MULTI-AGENT MODE
  Add an "agents" array to config.json. Each agent connects with its own
  bot token and can use a different provider:

  "agents": [
    { "name": "lucy",  "botToken": "ari_...", "provider": "anthropic-oauth" },
    { "name": "pan",   "botToken": "ari_...", "provider": "anthropic-oauth", "cwd": "~/projects" },
    { "name": "codex", "botToken": "ari_...", "provider": "openai-oauth",   "model": "o3" }
  ]

  Without "agents", the bridge runs in single-agent mode using arinova.botToken.

ENVIRONMENT VARIABLES
  ARINOVA_SERVER_URL    Override WebSocket server URL
  ARINOVA_BOT_TOKEN     Override bot token (single-agent mode)
  ARINOVA_AGENT_NAME    Override agent name (single-agent mode)
  DEFAULT_PROVIDER      Override default provider ID
  DEFAULT_CWD           Override default working directory
  MAX_SESSIONS          Override max concurrent sessions per provider
  MCP_CONFIG_PATH       Override MCP config file path
  DB_PATH               Override SQLite database path
  GITHUB_TOKEN          Enable GitHub MCP server (auto-detected)
`.trim());
}

function writePidFile(): void {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch { /* already gone */ }
}

async function cmdStart(): Promise<void> {
  writePidFile();
  process.on("exit", removePidFile);

  // Dynamic import to run the existing start logic
  await import("./index.js");
}

function cmdStop(): void {
  if (!fs.existsSync(PID_FILE)) {
    console.error("Bridge is not running (no PID file found).");
    process.exit(1);
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    console.error("Invalid PID file.");
    fs.unlinkSync(PID_FILE);
    process.exit(1);
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to bridge (PID ${pid}).`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      console.log(`Bridge process (PID ${pid}) is not running. Cleaning up PID file.`);
      fs.unlinkSync(PID_FILE);
    } else {
      console.error(`Failed to stop bridge: ${err}`);
      process.exit(1);
    }
  }
}

function cmdConfig(): void {
  const configPath = path.join(homedir(), ".arinova-bridge", "config.json");

  if (!fs.existsSync(configPath)) {
    console.error(`No config file found at ${configPath}`);
    console.error("Run `arinova-bridge setup` to create one.");
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  // Mask sensitive fields
  if (config.arinova?.botToken) {
    const t = config.arinova.botToken;
    config.arinova.botToken = t.length > 12 ? `${t.slice(0, 8)}...${t.slice(-4)}` : "****";
  }
  if (config.providers) {
    for (const p of config.providers) {
      if (p.apiKey) {
        const k = p.apiKey;
        p.apiKey = k.length > 12 ? `${k.slice(0, 8)}...${k.slice(-4)}` : "****";
      }
    }
  }

  console.log(JSON.stringify(config, null, 2));
}

async function cmdSetup(): Promise<void> {
  // Dynamic import to reuse existing setup logic
  await import("./setup.js");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  switch (command) {
    case "start":
      await cmdStart();
      break;
    case "stop":
      cmdStop();
      break;
    case "config":
      cmdConfig();
      break;
    case "setup":
      await cmdSetup();
      break;
    case "help":
    case "--help":
    case "-h":
      showHelp();
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
