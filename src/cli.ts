#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { cmdAgents } from "./cli/commands/agents.js";
import { cmdSpawn } from "./cli/commands/spawn.js";
import { cmdFork } from "./cli/commands/fork.js";
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version as string;
const PID_FILE = path.join(homedir(), ".arinova-bridge", "bridge.pid");

function showHelp(): void {
  console.log(
    `
arinova-bridge v${VERSION}
Multi-provider bridge between Arinova Chat and AI coding assistants.

INSTALL
  npm install -g @arinova-ai/arinova-bridge

QUICK START
  arinova-bridge setup          # Interactive config wizard
  arinova-bridge start          # Start the bridge server
  arinova-bridge --token=obt_*  # Onboarding: claim token and start

COMMANDS
  start    Start the bridge server (writes PID to ~/.arinova-bridge/bridge.pid)
  stop     Stop the running bridge server (sends SIGTERM via PID file)
  agents   A2A agent management (list, deliver, broadcast, status)
  spawn    Session spawn management (add, list, cancel)
  fork     Fork agent to execute task in sub-session (add, list, cancel)
  config   Show current configuration (secrets masked)
  setup    Interactive setup wizard (providers, bot token, statusLine)
  pin-claude  Copy a specific Claude Code version into the bridge vendor dir
              and point anthropic-cli providers at it. Defaults to the version
              declared in package.json -> arinovaBridge.pinnedClaudeVersion.
              Usage: arinova-bridge pin-claude [version]
  login    OAuth login for a specific provider (without re-running full setup)
  help     Show this help message

LOGIN SUBCOMMAND
  login                     Interactive provider selection
  login <provider-id>       Login to a specific provider (e.g. anthropic-oauth, minimax-oauth)
                             Providers with configDir login in that isolated account directory
  login <provider-id> --device-auth
                             Use device code auth flow (openai-oauth only)

AGENTS SUBCOMMAND
  agents                                    List all running agents
  agents --deliver <name> --content "msg"   Send message to a specific agent
  agents --deliver <name> --content "msg" --cwd ~/project --model claude-opus-4-6
                                            Deliver with custom cwd/model
  agents --deliver <name> --content "msg" --wait false
                                            Fire-and-forget (don't wait for response)
  agents --status <name>                    Show agent status & sessions
  agents --ping <name>                      Lightweight health check
  agents --cost [name]                      Show cost (specific agent or all)
  agents --stop <name>                      Interrupt all active tasks
  agents --reset <name>                     Reset all sessions
  agents --handoff <from> <to>              Hand off cwd/context from one agent to another
  agents --history [name]                   Show recent task history
  agents --watch                            Stream live agent activity

SPAWN SUBCOMMAND
  spawn --agent <parent> --target <target> --context 'task description'
                                            Spawn a sub-session task
  spawn list                                List all spawn jobs
  spawn list --agent <name>                 List spawn jobs for a specific agent
  spawn cancel --id <job-id>                Cancel a running spawn job

FORK SUBCOMMAND
  fork --agent <name> --task 'task description'
                                            Fork agent to execute task in sub-session
  fork --agent <name> --task '...' --model claude-sonnet-4-6 --cwd ~/project
                                            Fork with custom model and cwd
  fork list                                 List all fork jobs
  fork list --agent <name>                  List fork jobs for a specific agent
  fork cancel --id <job-id>                 Cancel a running fork job

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
      { "id": "anthropic-oauth", "type": "anthropic-cli", "displayName": "...", "enabled": true },
      { "id": "anthropic-oauth2", "type": "anthropic-cli", "displayName": "...", "enabled": true,
        "configDir": "~/.arinova-bridge/accounts/anthropic-oauth2" },
      { "id": "openai-oauth2", "type": "openai-cli", "displayName": "...", "enabled": true,
        "configDir": "~/.arinova-bridge/accounts/openai-oauth2" }
    ],
    "defaults": {
      "cwd": "~/projects",
      "maxSessions": 5,
      "idleTimeoutMs": 3600000,
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

AGENT PROMPT FILES
  Drop Markdown files into ~/.arinova-bridge/agents/ to inject system prompts.

  Naming rules:
    <name>.md              Per-agent prompt (filename must match agent name).
    _shared.md             Injected into every agent (no frontmatter needed).
    _shared_<group>.md     Group-scoped shared prompt. Requires an "include"
                           frontmatter listing agents it applies to; files
                           without a valid include list are skipped with a
                           warning at startup.

  Full frontmatter example (_shared_engineering.md):

    ---
    include:
      - pan
      - bella
    ---
    # Engineering shared prompt

    You are part of the engineering track...

  Inline form is also accepted:  include: [pan, bella]

  Prompt assembly order per agent:
    1. _shared.md (and legacy _*.md files), concatenated
    2. Matching _shared_<group>.md bodies (in filename-sorted order)
    3. <name>.md body

  Prompts are read once at bridge startup and cached; restart the bridge to
  reload after editing these files.

OPTIONS
  --token <token>       Bot token or onboarding claim token (obt_*).
                         Overrides ARINOVA_BOT_TOKEN. Implies "start" when
                         no command is given.

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

MULTI-OAUTH ACCOUNTS
  Add an extra provider manually with "configDir", then run:
    arinova-bridge login openai-oauth2
    arinova-bridge login anthropic-oauth2

  openai-cli maps configDir to CODEX_HOME.
  anthropic-cli maps configDir to CLAUDE_CONFIG_DIR.
`.trim(),
  );
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
  } catch {
    /* already gone */
  }
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

async function cmdPinClaude(args: string[]): Promise<void> {
  const { readPinnedVersion, pinClaudeBinary, ClaudeBinaryNotFoundError } = await import(
    "./claude-pin.js"
  );
  const { readConfigFile, writeConfigFile, getConfigPath } = await import("./config-file.js");

  // Positional version arg overrides package.json default. Anything starting
  // with `-` is treated as a flag (none are defined right now) and ignored.
  const explicit = args.find((a) => !a.startsWith("-"));
  const version = explicit ?? readPinnedVersion();
  if (!version) {
    console.error(
      "No version specified and package.json lacks `arinovaBridge.pinnedClaudeVersion`. " +
        "Pass a version explicitly: `arinova-bridge pin-claude 2.1.143`.",
    );
    process.exit(1);
  }

  let result;
  try {
    result = pinClaudeBinary(version);
  } catch (err) {
    if (err instanceof ClaudeBinaryNotFoundError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`Pinned Claude Code ${result.version}`);
  console.log(`  source : ~/.local/share/claude/versions/${result.version}`);
  console.log(`  dest   : ${result.pinnedPath}`);
  console.log(`  size   : ${Math.round(result.bytesCopied / 1024 / 1024)} MB`);

  // Update every anthropic-cli provider's claudePath. We don't touch other
  // provider types (openai-cli etc.) — they manage their own binaries.
  const config = readConfigFile();
  if (!config) {
    console.warn(
      `\nNo config file at ${getConfigPath()} — skipping claudePath update. ` +
        `Run \`arinova-bridge setup\` first, then re-run pin-claude.`,
    );
    return;
  }
  let updated = 0;
  for (const provider of config.providers) {
    if (provider.type === "anthropic-cli" && provider.claudePath !== result.pinnedPath) {
      provider.claudePath = result.pinnedPath;
      updated++;
    }
  }
  if (updated > 0) {
    writeConfigFile(config);
    console.log(`\nUpdated ${updated} anthropic-cli provider(s) in ${getConfigPath()}.`);
  } else {
    console.log(`\nAll anthropic-cli providers already pointing at the pinned binary.`);
  }
}

async function cmdLogin(args: string[]): Promise<void> {
  const { runLogin } = await import("./login.js");
  const providerId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const deviceAuth = args.includes("--device-auth");
  await runLogin(providerId, { deviceAuth });
}

function extractToken(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith("--token=")) return args[i].slice("--token=".length);
  }
  return undefined;
}

function stripTokenArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token") { i++; continue; }
    if (args[i].startsWith("--token=")) continue;
    out.push(args[i]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const token = extractToken(args);
  if (token) {
    process.env.ARINOVA_BOT_TOKEN = token;
  }

  const remaining = stripTokenArgs(args);
  const command = remaining[0] ?? (token ? "start" : "help");

  switch (command) {
    case "start":
      await cmdStart();
      break;
    case "stop":
      cmdStop();
      break;
    case "agents":
      await cmdAgents(args.slice(1));
      break;
    case "spawn":
      await cmdSpawn(args.slice(1));
      break;
    case "fork":
      await cmdFork(args.slice(1));
      break;
    case "config":
      cmdConfig();
      break;
    case "setup":
      await cmdSetup();
      break;
    case "pin-claude":
      await cmdPinClaude(args.slice(1));
      break;
    case "login":
      await cmdLogin(args.slice(1));
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
