import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { select, confirm } from "@inquirer/prompts";
import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import { readConfigFile } from "../config-file.js";
import { savePermanentToken } from "./token-persistence.js";
import type { Logger } from "../util/logger.js";

const PID_FILE = path.join(homedir(), ".arinova-bridge", "bridge.pid");

/** Start the bridge with PID file lifecycle (mirrors cmdStart in cli.ts). */
async function startBridge(): Promise<void> {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
  process.on("exit", () => { try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ } });
  await import("../index.js");
}

const DEFAULT_SERVER_URL = "wss://api.chat.arinova.ai";

type ClientId = "claude-code" | "codex" | "cursor" | "other";

function parseTokenFlag(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith("--token=")) return arg.slice("--token=".length);
  }
  const idx = args.indexOf("--token");
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

/**
 * Connect briefly to claim the obt_* token and retrieve the permanent ari_* token.
 * Disconnects immediately after the claim completes.
 */
async function claimToken(obtToken: string, serverUrl: string): Promise<string> {
  const agent = new ArinovaAgent({ serverUrl, botToken: obtToken });

  let permanentToken: string | null = null;
  agent.on("token_claimed", (data) => {
    permanentToken = data.permanentToken;
  });

  const timeout = setTimeout(() => {
    agent.disconnect();
  }, 30_000);

  try {
    await agent.connect();
  } catch (err) {
    clearTimeout(timeout);
    agent.disconnect();
    throw new Error(`Auth failed: ${err instanceof Error ? err.message : err}`);
  }

  clearTimeout(timeout);
  agent.disconnect();

  if (!permanentToken) {
    throw new Error("Server did not return a permanent token during claim");
  }
  return permanentToken;
}

/** MCP server entry pointing to the portable npx invocation of @arinova-ai/mcp-server. */
function arinovaMcpEntry(botToken: string, serverUrl: string) {
  return {
    command: "npx",
    args: ["-y", "@arinova-ai/mcp-server@latest"],
    env: {
      ARINOVA_BOT_TOKEN: botToken,
      ARINOVA_SERVER_URL: serverUrl,
    },
  };
}

/**
 * Read a JSON file, merge a key, and write it back. Creates parent dirs if needed.
 * Throws on malformed existing JSON to avoid silent data loss.
 */
function mergeJsonConfig(filePath: string, key: string, value: Record<string, unknown>): string {
  const dir = path.dirname(filePath);
  let config: Record<string, unknown> = {};

  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf-8");
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Cannot parse ${filePath} — fix the JSON manually or remove the file.\n` +
        `Parse error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const existing = (config[key] ?? {}) as Record<string, unknown>;
  config[key] = { ...existing, ...value };

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return filePath;
}

function writeClaudeCodeConfig(botToken: string, serverUrl: string): string {
  const configPath = path.join(homedir(), ".claude.json");
  return mergeJsonConfig(configPath, "mcpServers", {
    arinova: arinovaMcpEntry(botToken, serverUrl),
  });
}

function writeCursorConfig(botToken: string, serverUrl: string): string {
  const configPath = path.join(homedir(), ".cursor", "mcp.json");
  return mergeJsonConfig(configPath, "mcpServers", {
    arinova: arinovaMcpEntry(botToken, serverUrl),
  });
}

function writeCodexConfig(botToken: string, serverUrl: string): boolean {
  const entry = arinovaMcpEntry(botToken, serverUrl);
  const args = ["mcp", "add", "arinova"];
  for (const [key, val] of Object.entries(entry.env)) {
    args.push("--env", `${key}=${val}`);
  }
  args.push("--", entry.command, ...entry.args);

  try {
    execFileSync("codex", args, { timeout: 15_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function runOnboarding(args: string[]): Promise<void> {
  console.log("\n  Arinova Bridge Onboarding\n");

  // AC14.1: Parse --token
  const token = parseTokenFlag(args);
  if (!token) {
    console.error("Missing --token flag.\n\nUsage:\n  arinova-bridge onboarding --token=obt_xxx\n");
    process.exit(1);
  }

  if (!token.startsWith("obt_")) {
    console.error("Invalid token format. Expected obt_* onboarding token.\n");
    process.exit(1);
  }

  // AC14.6: Re-run detection — already configured with permanent token
  const existing = readConfigFile();
  if (existing?.arinova?.botToken && !existing.arinova.botToken.startsWith("obt_")) {
    console.log("  Bridge is already configured with a permanent token.\n");
    const action = await select<"overwrite" | "start" | "cancel">({
      message: "What would you like to do?",
      choices: [
        { name: "Overwrite with new token", value: "overwrite" as const },
        { name: "Start bridge with existing config", value: "start" as const },
        { name: "Cancel", value: "cancel" as const },
      ],
    });
    if (action === "cancel") return;
    if (action === "start") {
      console.log("\nStarting bridge...\n");
      await startBridge();
      return;
    }
  }

  // AC14.2: Claim token — lightweight connect, claim, disconnect
  const serverUrl = existing?.arinova?.serverUrl ?? DEFAULT_SERVER_URL;
  console.log("  Claiming onboarding token...");

  let permanentToken: string;
  try {
    permanentToken = await claimToken(token, serverUrl);
    console.log("  Token claimed\n");
  } catch (err) {
    console.error(`  Failed to claim token: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  // Save permanent token to bridge config
  const logger: Logger = {
    info: (msg) => console.log(`  ${msg}`),
    warn: (msg) => console.warn(`  ${msg}`),
    error: (msg) => console.error(`  ${msg}`),
  };
  savePermanentToken(permanentToken, logger);

  // AC14.3: Interactive client selection
  const client = await select<ClientId>({
    message: "Which AI client do you use?",
    choices: [
      { name: "Claude Code", value: "claude-code" as const },
      { name: "Codex CLI", value: "codex" as const },
      { name: "Cursor", value: "cursor" as const },
      { name: "Other", value: "other" as const },
    ],
  });

  // AC14.4: Auto-write client MCP config
  const mcpEntry = arinovaMcpEntry(permanentToken, serverUrl);
  switch (client) {
    case "claude-code": {
      const p = writeClaudeCodeConfig(permanentToken, serverUrl);
      console.log(`\n  MCP config written to ${p}`);
      break;
    }
    case "cursor": {
      const p = writeCursorConfig(permanentToken, serverUrl);
      console.log(`\n  MCP config written to ${p}`);
      break;
    }
    case "codex": {
      const ok = writeCodexConfig(permanentToken, serverUrl);
      if (ok) {
        console.log("\n  MCP server registered via codex CLI");
      } else {
        console.warn("\n  Could not find codex CLI. Add the MCP server manually:");
        console.warn("    codex mcp add arinova --env ARINOVA_BOT_TOKEN=" + permanentToken.slice(0, 8) + "... -- npx -y @arinova-ai/mcp-server@latest");
      }
      break;
    }
    case "other": {
      console.log("\n  Add this MCP server entry to your client's config:\n");
      console.log(JSON.stringify({ mcpServers: { arinova: mcpEntry } }, null, 2));
      console.log();
      break;
    }
  }

  console.log("  Arinova tools will be available next time you start your client.\n");

  // AC14.5: Auto-start bridge
  const startNow = await confirm({
    message: "Start bridge now?",
    default: true,
  });

  if (startNow) {
    console.log("\nStarting bridge...\n");
    await startBridge();
  } else {
    console.log("\nRun later with:\n  arinova-bridge start\n");
  }
}
