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
  agents   A2A agent management (list, deliver, broadcast, status)
  config   Show current configuration (secrets masked)
  setup    Interactive setup wizard (providers, bot token, statusLine)
  help     Show this help message

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

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const val = args[idx + 1];
  // Don't consume the next arg if it's another flag
  if (val.startsWith("--")) return undefined;
  return val;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function ipcError(resp: { error: { message: string } }): never {
  console.error(`Error: ${resp.error.message}`);
  process.exit(1);
}

async function cmdAgents(args: string[]): Promise<void> {
  const { sendIpcRequest, streamWatch } = await import("./ipc/client.js");
  const deliver = parseFlag(args, "--deliver");
  const status = parseFlag(args, "--status");
  const ping = parseFlag(args, "--ping");
  const cost = parseFlag(args, "--cost");
  const stop = parseFlag(args, "--stop");
  const reset = parseFlag(args, "--reset");
  const handoff = parseFlag(args, "--handoff");
  const history = parseFlag(args, "--history");
  const watch = hasFlag(args, "--watch");
  const content = parseFlag(args, "--content");
  const cwd = parseFlag(args, "--cwd");
  const model = parseFlag(args, "--model");
  const wait = parseFlag(args, "--wait");
  const costAll = hasFlag(args, "--cost");

  if (deliver) {
    // --- Deliver ---
    if (!content) {
      console.error("Missing --content flag.\nUsage: arinova-bridge agents --deliver <name> --content \"message\"");
      process.exit(1);
    }
    const params: { target: string; content: string; cwd?: string; model?: string; wait?: boolean } = {
      target: deliver, content,
    };
    if (cwd) params.cwd = cwd;
    if (model) params.model = model;
    if (wait === "false") params.wait = false;

    const resp = await sendIpcRequest({ id: 1, method: "deliver", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { agent: string; text?: string; durationMs?: number; queued?: boolean };
    if (r.queued) {
      console.log(`[${r.agent}] Message queued (fire-and-forget)`);
    } else {
      console.log(`[${r.agent}] (${r.durationMs}ms)\n${r.text}`);
    }
  } else if (status) {
    // --- Status ---
    const resp = await sendIpcRequest({ id: 1, method: "agent-status", params: { target: status } });
    if ("error" in resp) ipcError(resp);
    const s = resp.result as {
      name: string; provider: string; providerDisplayName: string;
      cwd: string; model: string; activeSessions: number;
      sessions: Array<{ sessionId: string; status: string; cwd: string; model: string }>;
    };
    console.log(`Agent: ${s.name}`);
    console.log(`Provider: ${s.providerDisplayName} (${s.provider})`);
    console.log(`CWD: ${s.cwd}`);
    console.log(`Model: ${s.model}`);
    console.log(`Active Sessions: ${s.activeSessions}`);
    if (s.sessions.length > 0) {
      console.log("\nSessions:");
      for (const sess of s.sessions) {
        console.log(`  ${sess.sessionId}  ${sess.status}  ${sess.model}  ${sess.cwd}`);
      }
    }
  } else if (ping) {
    // --- Ping ---
    const resp = await sendIpcRequest({ id: 1, method: "ping", params: { target: ping } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { agent: string; alive: boolean; provider: string; activeSessions: number; hasActiveSession: boolean };
    console.log(`${r.agent}: ${r.alive ? "alive" : "dead"}  provider=${r.provider}  sessions=${r.activeSessions}  active=${r.hasActiveSession}`);
  } else if (stop) {
    // --- Stop ---
    const resp = await sendIpcRequest({ id: 1, method: "agent-stop", params: { target: stop } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { agent: string; interrupted: number; totalSessions: number };
    console.log(`[${r.agent}] Interrupted ${r.interrupted}/${r.totalSessions} sessions`);
  } else if (reset) {
    // --- Reset ---
    const resp = await sendIpcRequest({ id: 1, method: "agent-reset", params: { target: reset } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { agent: string; reset: number; totalSessions: number };
    console.log(`[${r.agent}] Reset ${r.reset}/${r.totalSessions} sessions`);
  } else if (handoff) {
    // --- Handoff ---
    const to = args[args.indexOf("--handoff") + 2];
    if (!to) {
      console.error("Usage: arinova-bridge agents --handoff <from> <to>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "handoff", params: { from: handoff, to } });
    if ("error" in resp) ipcError(resp);
    const r = resp.result as { from: string; to: string; cwd: string; model: string; sessionCount: number };
    console.log(`Handoff: ${r.from} → ${r.to}`);
    console.log(`  CWD: ${r.cwd}`);
    console.log(`  Model: ${r.model}`);
    console.log(`  Sessions transferred context: ${r.sessionCount}`);
  } else if (watch) {
    // --- Watch (streaming) ---
    console.log("Watching agent activity... (Ctrl+C to stop)\n");
    streamWatch((line) => {
      try {
        const r = JSON.parse(line) as { agent: string; content: string; responsePreview: string; durationMs: number; costUsd?: number; model?: string; timestamp: number };
        const time = new Date(r.timestamp).toLocaleTimeString();
        const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(4)}` : "";
        console.log(`[${time}] ${r.agent} (${r.durationMs}ms${cost}) ${r.model ?? ""}`);
        console.log(`  → ${r.content}`);
        console.log(`  ← ${r.responsePreview}\n`);
      } catch {
        // skip ack or malformed lines
      }
    });
    // Keep process alive
    await new Promise(() => {});
  } else if (hasFlag(args, "--history")) {
    // --- History ---
    const target = history ?? undefined;
    const resp = await sendIpcRequest({ id: 1, method: "history", params: { target, limit: 20 } });
    if ("error" in resp) ipcError(resp);
    const records = resp.result as Array<{ agent: string; content: string; responsePreview: string; durationMs: number; costUsd?: number; model?: string; timestamp: number }>;
    if (records.length === 0) {
      console.log("No task history yet.");
      return;
    }
    for (const r of records) {
      const time = new Date(r.timestamp).toLocaleTimeString();
      const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(4)}` : "";
      console.log(`[${time}] ${r.agent} (${r.durationMs}ms${cost}) ${r.model ?? ""}`);
      console.log(`  → ${r.content}`);
      console.log(`  ← ${r.responsePreview}\n`);
    }
  } else if (costAll) {
    // --- Cost ---
    const resp = await sendIpcRequest({ id: 1, method: "agent-cost", params: cost ? { target: cost } : {} });
    if ("error" in resp) ipcError(resp);
    if (cost) {
      const c = resp.result as { agent: string; provider: string; totalCostUsd: number; inputTokens: number; outputTokens: number; sessions: number };
      console.log(`Agent: ${c.agent}`);
      console.log(`Cost: $${c.totalCostUsd.toFixed(4)}`);
      console.log(`Tokens: in=${c.inputTokens} out=${c.outputTokens}`);
      console.log(`Sessions: ${c.sessions}`);
    } else {
      const costs = resp.result as Array<{ agent: string; provider: string; totalCostUsd: number; inputTokens: number; outputTokens: number; sessions: number }>;
      if (costs.length === 0) { console.log("No cost data."); return; }
      let totalAll = 0;
      for (const c of costs) {
        totalAll += c.totalCostUsd;
        console.log(`  ${c.agent}  $${c.totalCostUsd.toFixed(4)}  in=${c.inputTokens} out=${c.outputTokens}  (${c.sessions} sessions)`);
      }
      console.log(`\n  Total: $${totalAll.toFixed(4)}`);
    }
  } else {
    // --- List all agents ---
    const resp = await sendIpcRequest({ id: 1, method: "list-agents" });
    if ("error" in resp) ipcError(resp);
    const agents = resp.result as Array<{ name: string; provider: string; providerDisplayName: string; cwd: string; model: string }>;
    if (agents.length === 0) {
      console.log("No agents running.");
      return;
    }
    console.log("Running agents:\n");
    for (const a of agents) {
      console.log(`  ${a.name}  ${a.providerDisplayName}  ${a.model}  ${a.cwd}`);
    }
  }
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
    case "agents":
      await cmdAgents(args.slice(1));
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
