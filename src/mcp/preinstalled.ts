import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Logger } from "../util/logger.js";

const require = createRequire(import.meta.url);

/**
 * Abstraction over filesystem operations used by this module.
 * Inject a custom implementation for testing; production code uses `defaultFs`.
 */
export interface FileSystem {
  writeFileSync(path: string, data: string, encoding?: string): void;
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

const defaultFs: FileSystem = {
  writeFileSync: writeFileSync as FileSystem["writeFileSync"],
  readFileSync: readFileSync as FileSystem["readFileSync"],
  existsSync,
  mkdirSync: mkdirSync as FileSystem["mkdirSync"],
};

export interface ArinovaMcpEnv {
  botToken: string;
  serverUrl: string;
}

/**
 * MCP server definition for pre-installed servers.
 */
export interface McpStdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpServerMapOptions {
  arinovaAuth?: "explicit" | "inherited";
  codexHome?: string;
}

function formatExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err as Error & {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number;
    signal?: string;
  };
  const stdout = detail.stdout ? String(detail.stdout).trim() : "";
  const stderr = detail.stderr ? String(detail.stderr).trim() : "";
  const parts = [
    detail.message,
    detail.status !== undefined ? `status=${detail.status}` : "",
    detail.signal ? `signal=${detail.signal}` : "",
    stdout ? `stdout=${stdout}` : "",
    stderr ? `stderr=${stderr}` : "",
  ].filter(Boolean);
  return parts.join(" ");
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
export type McpSdkServers = Record<
  string,
  { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
>;

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
 * Build the full server map including conditional servers (e.g. GitHub).
 */
function buildServerMap(
  arinova?: ArinovaMcpEnv,
  userServers?: Record<string, McpStdioServer>,
  options: McpServerMapOptions = {},
): Record<string, McpStdioServer> {
  const servers: Record<string, McpStdioServer> = { ...PREINSTALLED_SERVERS };

  const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (githubToken) {
    servers.github = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
    };
  }

  const arinovaAuth = options.arinovaAuth ?? "explicit";
  const botToken = arinova?.botToken ?? process.env.ARINOVA_BOT_TOKEN;
  const serverUrl = arinova?.serverUrl ?? process.env.ARINOVA_SERVER_URL;
  if ((botToken || arinovaAuth === "inherited") && serverUrl) {
    const cliPath = require.resolve("@arinova-ai/mcp-server/dist/cli.js");
    const args = [cliPath, "--strict-startup"];
    const env: Record<string, string> = {};
    if (arinovaAuth === "explicit" && botToken) {
      env.ARINOVA_BOT_TOKEN = botToken;
      env.ARINOVA_SERVER_URL = serverUrl;
    } else {
      args.push("--server-url", serverUrl);
    }
    servers.arinova = {
      command: "node",
      args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  // User-defined servers from config override preinstalled ones
  if (userServers) {
    Object.assign(servers, userServers);
  }

  return servers;
}

/**
 * Get the pre-installed MCP servers as SDK-compatible config.
 * Used by anthropic-sdk provider to pass mcpServers to query().
 */
export function getPreinstalledMcpServers(
  arinova?: ArinovaMcpEnv,
  userServers?: Record<string, McpStdioServer>,
): McpSdkServers {
  const servers = buildServerMap(arinova, userServers);
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
export function ensureCliMcpConfig(
  userMcpConfigPath: string | undefined,
  logger: Logger,
  arinova?: ArinovaMcpEnv,
  userServers?: Record<string, McpStdioServer>,
  fs: FileSystem = defaultFs,
): string | undefined {
  // User-provided config takes priority
  if (userMcpConfigPath) {
    return userMcpConfigPath;
  }

  try {
    fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });

    const config: McpCliConfig = {
      mcpServers: buildServerMap(arinova, userServers),
    };

    const desired = JSON.stringify(config, null, 2);
    const existing = fs.existsSync(MCP_CLI_CONFIG_PATH) ? fs.readFileSync(MCP_CLI_CONFIG_PATH, "utf-8") : "";

    if (desired !== existing) {
      fs.writeFileSync(MCP_CLI_CONFIG_PATH, desired, "utf-8");
      logger.info(`mcp: generated CLI config at ${MCP_CLI_CONFIG_PATH}`);
    }

    return MCP_CLI_CONFIG_PATH;
  } catch (err) {
    logger.error(`mcp: failed to generate CLI config: ${err}`);
    return undefined;
  }
}

/**
 * Generate a per-agent CLI MCP config with the agent's own bot token.
 * Returns the path to the generated config file.
 */
export function ensureAgentCliMcpConfig(
  agentName: string,
  logger: Logger,
  arinova: ArinovaMcpEnv,
  userServers?: Record<string, McpStdioServer>,
  fs: FileSystem = defaultFs,
): string | undefined {
  try {
    fs.mkdirSync(MCP_CONFIG_DIR, { recursive: true });

    const configPath = path.join(MCP_CONFIG_DIR, `${agentName}.json`);
    const config: McpCliConfig = {
      mcpServers: buildServerMap(arinova, userServers),
    };

    const desired = JSON.stringify(config, null, 2);
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";

    if (desired !== existing) {
      fs.writeFileSync(configPath, desired, "utf-8");
      logger.info(`mcp: generated per-agent CLI config for "${agentName}" at ${configPath}`);
    }

    return configPath;
  } catch (err) {
    logger.error(`mcp: failed to generate per-agent CLI config for "${agentName}": ${err}`);
    return undefined;
  }
}

/**
 * Pre-install MCP servers for Codex CLI using `codex mcp add`.
 * Idempotent — re-adding an existing server just overwrites it.
 */
export function ensureCodexMcpServers(
  codexPath: string,
  logger: Logger,
  arinova?: ArinovaMcpEnv,
  userServers?: Record<string, McpStdioServer>,
  options: McpServerMapOptions = {},
): void {
  const servers = buildServerMap(arinova, userServers, options);

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

      execFileSync(codexPath, args, {
        timeout: 15_000,
        stdio: "pipe",
        env: options.codexHome ? { ...process.env, CODEX_HOME: options.codexHome } : process.env,
      });
    } catch (err) {
      logger.error(`mcp: codex mcp add ${name} failed: ${formatExecError(err)}`);
    }
  }
}

function ensureCodexAuthLink(codexHome: string, logger: Logger, authSourceDir?: string): void {
  mkdirSync(codexHome, { recursive: true });

  const sourceAuth = path.join(authSourceDir ?? path.join(homedir(), ".codex"), "auth.json");
  const targetAuth = path.join(codexHome, "auth.json");
  if (!existsSync(sourceAuth)) {
    logger.warn(`mcp: Codex auth source not found at ${sourceAuth}; per-agent CODEX_HOME may need login`);
    return;
  }

  try {
    if (existsSync(targetAuth) || lstatSync(targetAuth, { throwIfNoEntry: false })) {
      rmSync(targetAuth, { force: true });
    }
    symlinkSync(sourceAuth, targetAuth);
  } catch (err) {
    logger.warn(`mcp: failed to symlink Codex auth into ${codexHome}, copying instead: ${err}`);
    cpSync(sourceAuth, targetAuth);
  }
}

/**
 * Create/update an isolated Codex home for one bridge agent.
 *
 * Codex stores MCP definitions under CODEX_HOME. Keeping a separate home per
 * agent prevents one OpenAI-backed agent's Arinova bot token from being written
 * into the global Codex config or overwriting another OpenAI provider/agent.
 */
export function ensureAgentCodexHome(
  codexPath: string,
  logger: Logger,
  codexHome: string,
  arinova: ArinovaMcpEnv,
  userServers?: Record<string, McpStdioServer>,
  authSourceDir?: string,
): string {
  ensureCodexAuthLink(codexHome, logger, authSourceDir);
  ensureCodexMcpServers(codexPath, logger, arinova, userServers, {
    arinovaAuth: "explicit",
    codexHome,
  });
  return codexHome;
}
