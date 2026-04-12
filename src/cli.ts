#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { CronExpressionParser } from "cron-parser";

const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;
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
  cron     Cron job management (add, list, delete)
  spawn    Session spawn management (add, list, cancel)
  fork     Fork agent to execute task in sub-session (add, list, cancel)
  config   Show current configuration (secrets masked)
  setup    Interactive setup wizard (providers, bot token, statusLine)
  login    OAuth login for a specific provider (without re-running full setup)
  help     Show this help message

LOGIN SUBCOMMAND
  login                     Interactive provider selection
  login <provider-id>       Login to a specific provider (e.g. anthropic-oauth, minimax-oauth)

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

CRON SUBCOMMAND
  cron                                      List all cron jobs (all agents)
  cron add --agent <name> --expr '*/10 * * * *' --message 'check status'
                                            Add a cron job for an agent
  cron add --agent <name> --expr '0 9 * * *' --message 'daily report' --max-runs 30
                                            Add with max execution count
  cron list                                 List all cron jobs
  cron list --agent <name>                  List cron jobs for a specific agent
  cron delete --agent <name> --id <job-id>  Delete a specific cron job
  cron delete --agent <name> --id all       Delete all cron jobs for an agent

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

async function cmdLogin(args: string[]): Promise<void> {
  const { runLogin } = await import("./login.js");
  const providerId = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  await runLogin(providerId);
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
  const source = parseFlag(args, "--source") ?? process.env.ARINOVA_AGENT_NAME;
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
    const params: { target: string; content: string; source?: string; cwd?: string; model?: string; wait?: boolean } = {
      target: deliver, content,
    };
    if (source) params.source = source;
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

async function cmdCron(args: string[]): Promise<void> {
  const { sendIpcRequest } = await import("./ipc/client.js");
  const sub = args[0]?.toLowerCase();

  if (sub === "add") {
    const agent = parseFlag(args, "--agent");
    const expr = parseFlag(args, "--expr");
    const message = parseFlag(args, "--message");
    const maxRunsStr = parseFlag(args, "--max-runs");

    if (!agent || !expr || !message) {
      console.error("Usage: arinova-bridge cron add --agent <name> --expr '<cron>' --message '<msg>' [--max-runs <n>]");
      process.exit(1);
    }

    const params: { agent: string; expr: string; message: string; maxRuns?: number } = { agent, expr, message };
    if (maxRunsStr) {
      const n = parseInt(maxRunsStr, 10);
      if (isNaN(n) || n < 1) {
        console.error("--max-runs must be a positive integer");
        process.exit(1);
      }
      params.maxRuns = n;
    }

    const resp = await sendIpcRequest({ id: 1, method: "cron-add", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { id: string; agentName: string; cronExpr: string; message: string };
    console.log(`Added cron job: ${r.id}`);
    console.log(`  Agent: ${r.agentName}`);
    console.log(`  Schedule: ${r.cronExpr}`);
    console.log(`  Message: ${r.message}`);
  } else if (sub === "delete" || sub === "del" || sub === "rm") {
    const agent = parseFlag(args, "--agent");
    const id = parseFlag(args, "--id");

    if (!agent || !id) {
      console.error("Usage: arinova-bridge cron delete --agent <name> --id <job-id|all>");
      process.exit(1);
    }

    const resp = await sendIpcRequest({ id: 1, method: "cron-delete", params: { agent, id } });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { deleted: number; id?: string; agentName: string; cronExpr?: string; message?: string };
    if (r.id) {
      console.log(`Deleted cron job: ${r.id} (${r.cronExpr} — ${r.message})`);
    } else {
      console.log(`Deleted ${r.deleted} cron job(s) for agent "${r.agentName}"`);
    }
  } else {
    // list (default)
    const agent = parseFlag(args, "--agent");
    const params: { agent?: string } = {};
    if (agent) params.agent = agent;

    const resp = await sendIpcRequest({ id: 1, method: "cron-list", params });
    if ("error" in resp) ipcError(resp);

    const jobs = resp.result as Array<{
      id: string; agentName: string; cronExpr: string; message: string;
      enabled: boolean; runCount: number; maxRuns: number | null;
      lastRunAt: number | null; createdAt: number;
    }>;

    if (jobs.length === 0) {
      console.log("No cron jobs.");
      return;
    }

    console.log("Cron Jobs:\n");
    for (const job of jobs) {
      const status = job.enabled ? "✅" : "⏸️";
      const lastRun = job.lastRunAt
        ? new Date(job.lastRunAt).toLocaleString()
        : "—";
      const maxInfo = job.maxRuns !== null ? `${job.runCount}/${job.maxRuns}` : `${job.runCount}x`;
      let nextRun = "—";
      if (job.enabled) {
        try {
          const expr = CronExpressionParser.parse(job.cronExpr);
          nextRun = expr.next().toDate().toLocaleString();
        } catch { /* skip */ }
      }
      console.log(`  ${status} ${job.id}  ${job.agentName}  ${job.cronExpr}  ${job.message}`);
      console.log(`     Last: ${lastRun}  Runs: ${maxInfo}`);
      console.log(`     Next: ${nextRun}`);
    }
  }
}

async function cmdSpawn(args: string[]): Promise<void> {
  const { sendIpcRequest } = await import("./ipc/client.js");
  const sub = args[0]?.toLowerCase();

  if (sub === "cancel") {
    const id = parseFlag(args, "--id");
    if (!id) {
      console.error("Usage: arinova-bridge spawn cancel --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "spawn-cancel", params: { id } });
    if ("error" in resp) ipcError(resp);
    console.log(`Cancelled spawn job: ${id}`);
  } else if (sub === "result") {
    const id = parseFlag(args, "--id") ?? args[1];
    if (!id) {
      console.error("Usage: arinova-bridge spawn result --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "spawn-result", params: { id } });
    if ("error" in resp) ipcError(resp);

    const job = resp.result as {
      id: string; parentAgent: string; targetAgent: string; status: string;
      context: string; result: string | null;
      createdAt: number; completedAt: number | null;
      durationMs: number | null; model: string | null; costUsd: number | null;
    };

    const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";
    const duration = job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : "—";
    const cost = job.costUsd != null ? `$${job.costUsd.toFixed(4)}` : "—";
    const time = new Date(job.createdAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

    console.log(`${statusIcon} Spawn Job: ${job.id}`);
    console.log(`  Parent: ${job.parentAgent}  Target: ${job.targetAgent}`);
    console.log(`  Status: ${job.status}  Duration: ${duration}  Cost: ${cost}`);
    console.log(`  Created: ${time}`);
    if (job.model) console.log(`  Model: ${job.model}`);
    console.log(`\n--- Context ---\n${job.context}`);
    if (job.result) {
      console.log(`\n--- Result ---\n${job.result}`);
    } else if (job.status === "running") {
      console.log(`\n(Job is still running — no result yet)`);
    } else {
      console.log(`\n(No result)`);
    }
  } else if (sub === "list" || !sub) {
    const agent = parseFlag(args, "--agent");
    const params: { agent?: string } = {};
    if (agent) params.agent = agent;

    const resp = await sendIpcRequest({ id: 1, method: "spawn-list", params });
    if ("error" in resp) ipcError(resp);

    const jobs = resp.result as Array<{
      id: string; parentAgent: string; targetAgent: string; status: string;
      durationMs: number | null; model: string | null; costUsd: number | null;
      createdAt: number; completedAt: number | null;
      contextPreview: string; resultPreview: string | null;
    }>;

    if (jobs.length === 0) {
      console.log("No spawn jobs.");
      return;
    }

    console.log("Spawn Jobs:\n");
    for (const job of jobs) {
      const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";
      const duration = job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : "—";
      const cost = job.costUsd != null ? ` $${job.costUsd.toFixed(4)}` : "";
      console.log(`  ${statusIcon} ${job.id}  ${job.parentAgent} → ${job.targetAgent}  ${job.status}  ${duration}${cost}`);
      console.log(`     Context: ${job.contextPreview}`);
      if (job.resultPreview) {
        console.log(`     Result: ${job.resultPreview}`);
      }
    }
  } else {
    // spawn --agent <parent> --target <target> --context '...'
    const agent = parseFlag(args, "--agent");
    const target = parseFlag(args, "--target");
    const context = parseFlag(args, "--context");
    const model = parseFlag(args, "--model");
    const cwd = parseFlag(args, "--cwd");

    if (!agent || !target || !context) {
      console.error("Usage: arinova-bridge spawn --agent <parent> --target <target> --context 'task description' [--model <model>] [--cwd <path>]");
      process.exit(1);
    }

    const params: { parentAgent: string; targetAgent: string; context: string; model?: string; cwd?: string } = {
      parentAgent: agent,
      targetAgent: target,
      context,
    };
    if (model) params.model = model;
    if (cwd) params.cwd = cwd;

    const resp = await sendIpcRequest({ id: 1, method: "spawn-add", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { id: string; parentAgent: string; targetAgent: string; status: string };
    console.log(`Spawned: ${r.id}`);
    console.log(`  ${r.parentAgent} → ${r.targetAgent}  status=${r.status}`);
    console.log(`\nUse 'arinova-bridge spawn list' to check progress.`);
  }
}

async function cmdFork(args: string[]): Promise<void> {
  const { sendIpcRequest } = await import("./ipc/client.js");
  const sub = args[0]?.toLowerCase();

  if (sub === "cancel") {
    const id = parseFlag(args, "--id");
    if (!id) {
      console.error("Usage: arinova-bridge fork cancel --id <job-id>");
      process.exit(1);
    }
    const resp = await sendIpcRequest({ id: 1, method: "fork-cancel", params: { id } });
    if ("error" in resp) ipcError(resp);
    console.log(`Cancelled fork job: ${id}`);
  } else if (sub === "list" || (!sub && !hasFlag(args, "--agent"))) {
    const agent = parseFlag(args, "--agent");
    const params: { agent?: string } = {};
    if (agent) params.agent = agent;

    const resp = await sendIpcRequest({ id: 1, method: "fork-list", params });
    if ("error" in resp) ipcError(resp);

    const jobs = resp.result as Array<{
      id: string; parentAgent: string; status: string;
      durationMs: number | null; model: string | null;
      createdAt: number; completedAt: number | null;
      taskPreview: string; resultPreview: string | null;
    }>;

    if (jobs.length === 0) {
      console.log("No fork jobs.");
      return;
    }

    console.log("Fork Jobs:\n");
    for (const job of jobs) {
      const statusIcon = job.status === "running" ? "🔄" : job.status === "completed" ? "✅" : job.status === "failed" ? "❌" : "⏸️";
      const duration = job.durationMs ? `${Math.round(job.durationMs / 1000)}s` : "—";
      console.log(`  ${statusIcon} ${job.id}  ${job.parentAgent}  ${job.status}  ${duration}`);
      console.log(`     Task: ${job.taskPreview}`);
      if (job.resultPreview) {
        console.log(`     Result: ${job.resultPreview}`);
      }
    }
  } else {
    // fork --agent <name> --task '...' [--model] [--cwd]
    const agent = parseFlag(args, "--agent");
    const task = parseFlag(args, "--task");
    const model = parseFlag(args, "--model");
    const cwd = parseFlag(args, "--cwd");

    if (!agent || !task) {
      console.error("Usage: arinova-bridge fork --agent <name> --task 'task description' [--model <model>] [--cwd <path>]");
      process.exit(1);
    }

    const params: { agent: string; task: string; model?: string; cwd?: string } = { agent, task };
    if (model) params.model = model;
    if (cwd) params.cwd = cwd;

    const resp = await sendIpcRequest({ id: 1, method: "fork-add", params });
    if ("error" in resp) ipcError(resp);

    const r = resp.result as { id: string; parentAgent: string; status: string };
    console.log(`Forked: ${r.id}`);
    console.log(`  Agent: ${r.parentAgent}  status=${r.status}`);
    console.log(`\nUse 'arinova-bridge fork list' to check progress.`);
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
    case "cron":
      await cmdCron(args.slice(1));
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
