import { homedir } from "node:os";
import path from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Logger } from "../util/logger.js";

/**
 * MCP server definition for pre-installed servers.
 */
export interface McpStdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * MCP config format compatible with Claude CLI's --mcp-config flag.
 */
export interface McpCliConfig {
  mcpServers: Record<string, McpStdioServer>;
}

/**
 * MCP config format compatible with Claude SDK's query() mcpServers option.
 */
export type McpSdkServers = Record<string, { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }>;

/** Default pre-installed MCP servers with pinned versions. */
const PREINSTALLED_SERVERS: Record<string, McpStdioServer> = {
  playwright: {
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.68"],
  },
};

/**
 * GitHub MCP server — only included when GITHUB_TOKEN is available.
 */
const GITHUB_MCP_SERVER: McpStdioServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" }, // placeholder, filled at runtime
};

/** Directory where generated MCP config files are stored. */
const MCP_CONFIG_DIR = path.join(homedir(), ".arinova-bridge", "mcp");

/** Path to the auto-generated CLI MCP config JSON. */
const MCP_CLI_CONFIG_PATH = path.join(MCP_CONFIG_DIR, "preinstalled.json");

/**
 * Build the full server map including conditional servers (e.g. GitHub).
 */
function buildServerMap(): Record<string, McpStdioServer> {
  const servers: Record<string, McpStdioServer> = { ...PREINSTALLED_SERVERS };

  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (githubToken) {
    servers.github = {
      ...GITHUB_MCP_SERVER,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
    };
  }

  return servers;
}

/**
 * Get the pre-installed MCP servers as SDK-compatible config.
 * Used by anthropic-sdk provider to pass mcpServers to query().
 */
export function getPreinstalledMcpServers(): McpSdkServers {
  const servers = buildServerMap();
  const result: McpSdkServers = {};
  for (const [name, server] of Object.entries(servers)) {
    result[name] = {
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return result;
}

/**
 * Generate the CLI MCP config JSON file and return its path.
 * Used by anthropic-cli provider for --mcp-config flag.
 * If a user-provided mcpConfigPath is set, returns that instead.
 */
export function ensureCliMcpConfig(userMcpConfigPath: string | undefined, logger: Logger): string | undefined {
  // User-provided config takes priority
  if (userMcpConfigPath) {
    return userMcpConfigPath;
  }

  try {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });

    const config: McpCliConfig = {
      mcpServers: buildServerMap(),
    };

    const desired = JSON.stringify(config, null, 2);
    const existing = existsSync(MCP_CLI_CONFIG_PATH)
      ? readFileSync(MCP_CLI_CONFIG_PATH, "utf-8")
      : "";

    if (desired !== existing) {
      writeFileSync(MCP_CLI_CONFIG_PATH, desired, "utf-8");
      logger.info(`mcp: generated CLI config at ${MCP_CLI_CONFIG_PATH}`);
    }

    return MCP_CLI_CONFIG_PATH;
  } catch (err) {
    logger.error(`mcp: failed to generate CLI config: ${err}`);
    return undefined;
  }
}

/**
 * Pre-install MCP servers for Codex CLI using `codex mcp add`.
 * Idempotent — re-adding an existing server just overwrites it.
 */
export function ensureCodexMcpServers(codexPath: string, logger: Logger): void {
  const servers = buildServerMap();

  for (const [name, server] of Object.entries(servers)) {
    try {
      // codex mcp add <name> [--env KEY=VALUE ...] -- <command> [args...]
      const args = ["mcp", "add", name];

      // --env flags must come before --
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          args.push("--env", `${key}=${value}`);
        }
      }

      args.push("--", server.command, ...server.args);

      execFileSync(codexPath, args, { timeout: 15_000, stdio: "pipe" });
      logger.info(`mcp: codex mcp add ${name} — ok`);
    } catch (err) {
      logger.error(`mcp: codex mcp add ${name} failed: ${err}`);
    }
  }
}

/**
 * Pre-install MCP servers for Gemini CLI using `gemini mcp add`.
 * Idempotent — re-adding an existing server just overwrites it.
 */
export function ensureGeminiMcpServers(geminiPath: string, logger: Logger): void {
  const servers = buildServerMap();

  for (const [name, server] of Object.entries(servers)) {
    try {
      // gemini mcp add <name> <command> [args...] --scope user --trust
      const args = [
        "mcp", "add", name,
        server.command,
        ...server.args,
        "--scope", "user",
        "--trust",
      ];

      // Add env vars
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          args.push("-e", `${key}=${value}`);
        }
      }

      execFileSync(geminiPath, args, { timeout: 15_000, stdio: "pipe" });
      logger.info(`mcp: gemini mcp add ${name} — ok`);
    } catch (err) {
      logger.error(`mcp: gemini mcp add ${name} failed: ${err}`);
    }
  }
}
