#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const VERSION = "0.0.1";
const PID_FILE = path.join(homedir(), ".arinova-bridge", "bridge.pid");

function showHelp(): void {
  console.log(`
arinova-bridge v${VERSION}

Usage: arinova-bridge <command>

Commands:
  start    Start the bridge server
  stop     Stop the running bridge server
  config   Show current configuration
  setup    Interactive setup wizard
  help     Show this help message

Examples:
  arinova-bridge start
  arinova-bridge setup
  arinova-bridge config
  arinova-bridge stop
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
