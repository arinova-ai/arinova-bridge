import { homedir } from "node:os";
import path from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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

/** Directory where generated MCP config files are stored. */
const MCP_CONFIG_DIR = path.join(homedir(), ".arinova-bridge", "mcp");

/** Path to the auto-generated CLI MCP config JSON. */
const MCP_CLI_CONFIG_PATH = path.join(MCP_CONFIG_DIR, "preinstalled.json");

/**
 * Get the pre-installed MCP servers as SDK-compatible config.
 * Used by anthropic-sdk provider to pass mcpServers to query().
 */
export function getPreinstalledMcpServers(): McpSdkServers {
  const result: McpSdkServers = {};
  for (const [name, server] of Object.entries(PREINSTALLED_SERVERS)) {
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
      mcpServers: PREINSTALLED_SERVERS,
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
