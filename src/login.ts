import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { select, confirm } from "@inquirer/prompts";
import { readConfigFile, resolveProviderConfigDir, type ProviderEntry } from "./config-file.js";
import { readOAuthToken, writeOAuthToken, isTokenExpired } from "./oauth/token-store.js";
import { performMiniMaxOAuth, type MiniMaxRegion } from "./oauth/minimax.js";

/**
 * Determine login strategy for a provider.
 * Returns "minimax" for device-code OAuth, "cli" for CLI-based OAuth, or "none" for API-key-only.
 */
function loginStrategy(entry: ProviderEntry): "minimax" | "cli" | "none" {
  // API-key providers don't need OAuth login
  if (entry.apiKey && !entry.baseUrl) return "none";

  // anthropic-cli with baseUrl (MiniMax, Zhipu, etc.) uses device code flow
  if (entry.type === "anthropic-cli" && entry.baseUrl) return "minimax";

  // CLI-based providers use their respective CLI login commands
  if (entry.type === "anthropic-cli" || entry.type === "openai-cli" || entry.type === "gemini-cli") {
    return "cli";
  }

  return "none";
}

/**
 * Get the CLI login command for a provider type.
 */
function getCliLoginCommand(entry: ProviderEntry): { cmd: string; args: string[] } | null {
  switch (entry.type) {
    case "anthropic-cli":
      return { cmd: entry.claudePath ?? "claude", args: ["login"] };
    case "openai-cli":
      return { cmd: entry.codexPath ?? "codex", args: ["auth", "login"] };
    case "gemini-cli":
      return { cmd: entry.geminiPath ?? "gemini", args: ["auth", "login"] };
    default:
      return null;
  }
}

function getCliConfigEnv(entry: ProviderEntry): Record<string, string> {
  const configDir = resolveProviderConfigDir(entry.configDir);
  if (!configDir) return {};

  switch (entry.type) {
    case "anthropic-cli":
      return { CLAUDE_CONFIG_DIR: configDir };
    case "openai-cli":
      return { CODEX_HOME: configDir };
    default:
      return {};
  }
}

/**
 * Run MiniMax device-code OAuth flow for a provider.
 */
async function loginMiniMax(entry: ProviderEntry): Promise<void> {
  // Check for existing valid token
  const existing = readOAuthToken(entry.id);
  if (existing && !isTokenExpired(existing)) {
    const expiresDate = new Date(existing.expiresAt * 1000).toLocaleString();
    console.log(`\n${entry.displayName}: 已有有效 token（到期: ${expiresDate}）`);
    const relogin = await confirm({ message: "重新登入？", default: false });
    if (!relogin) return;
  }

  // Region selection
  const region = await select<MiniMaxRegion>({
    message: `${entry.displayName} Region`,
    choices: [
      { name: "Global (api.minimax.io)", value: "global" },
      { name: "China (api.minimaxi.com)", value: "cn" },
    ],
    default: "global",
  });

  const token = await performMiniMaxOAuth(region);
  writeOAuthToken(entry.id, token);
  console.log(`\n✓ ${entry.displayName} OAuth 登入成功`);
}

/**
 * Run CLI-based login (claude login, codex auth login, gemini auth login).
 */
function loginCli(entry: ProviderEntry): void {
  const login = getCliLoginCommand(entry);
  if (!login) {
    console.error(`No login command for provider type "${entry.type}"`);
    process.exit(1);
  }

  const configEnv = getCliConfigEnv(entry);
  const configDir = resolveProviderConfigDir(entry.configDir);
  if (configDir && Object.keys(configEnv).length > 0) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  console.log(`\nRunning: ${login.cmd} ${login.args.join(" ")}`);
  if (Object.keys(configEnv).length > 0) {
    const envSummary = Object.entries(configEnv).map(([key, value]) => `${key}=${value}`).join(" ");
    console.log(`Using: ${envSummary}`);
  }
  console.log("──────────────────────────────────────\n");

  const result = spawnSync(login.cmd, login.args, {
    stdio: "inherit",
    env: { ...process.env, ...configEnv },
  });

  if (result.error) {
    console.error(`\n✗ Failed to run "${login.cmd}": ${result.error.message}`);
    console.error(`  Make sure "${login.cmd}" is installed and in your PATH.`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\n✗ ${login.cmd} exited with code ${result.status}`);
    process.exit(1);
  }

  console.log(`\n✓ ${entry.displayName} login complete`);
}

/**
 * Check if a CLI-based provider is logged in.
 * Returns { loggedIn, detail } where detail is a human-readable status string.
 */
function checkCliLoginStatus(entry: ProviderEntry): { loggedIn: boolean; detail: string } {
  switch (entry.type) {
    case "anthropic-cli": {
      // `claude auth status` returns JSON with loggedIn field
      const cmd = entry.claudePath ?? "claude";
      try {
        const result = spawnSync(cmd, ["auth", "status"], {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...getCliConfigEnv(entry) },
        });
        if (result.status === 0 && result.stdout) {
          const data = JSON.parse(result.stdout);
          if (data.loggedIn) {
            return { loggedIn: true, detail: data.email ?? "logged in" };
          }
        }
      } catch { /* ignore */ }
      return { loggedIn: false, detail: "not logged in" };
    }
    case "openai-cli": {
      // Codex stores auth in CODEX_HOME/auth.json, defaulting to ~/.codex/auth.json
      const authPath = path.join(resolveProviderConfigDir(entry.configDir) ?? path.join(homedir(), ".codex"), "auth.json");
      try {
        if (fs.existsSync(authPath)) {
          const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
          if (raw.tokens?.access_token) {
            const email = raw.tokens?.id_token
              ? (() => {
                  try {
                    const payload = JSON.parse(Buffer.from(raw.tokens.id_token.split(".")[1], "base64url").toString());
                    return payload.email as string | undefined;
                  } catch { return undefined; }
                })()
              : undefined;
            return { loggedIn: true, detail: email ?? "logged in" };
          }
        }
      } catch { /* ignore */ }
      return { loggedIn: false, detail: "not logged in" };
    }
    case "gemini-cli": {
      // Gemini stores auth in ~/.gemini/ — check if credentials exist
      const credPath = path.join(homedir(), ".gemini", "credentials.json");
      try {
        if (fs.existsSync(credPath)) {
          return { loggedIn: true, detail: "logged in" };
        }
      } catch { /* ignore */ }
      return { loggedIn: false, detail: "not logged in" };
    }
    default:
      return { loggedIn: false, detail: "unknown" };
  }
}

/**
 * Get display status for a provider in the login menu.
 */
function getProviderStatus(entry: ProviderEntry): string {
  const strategy = loginStrategy(entry);
  if (strategy === "minimax") {
    // MiniMax uses our own token store
    const token = readOAuthToken(entry.id);
    if (token) {
      return isTokenExpired(token) ? " (expired)" : ` (valid until ${new Date(token.expiresAt * 1000).toLocaleDateString()})`;
    }
    return " (not logged in)";
  }
  if (strategy === "cli") {
    const status = checkCliLoginStatus(entry);
    return status.loggedIn ? ` (${status.detail})` : " (not logged in)";
  }
  return "";
}

/**
 * Main login flow.
 * @param providerId - optional provider ID to login directly
 */
export async function runLogin(providerId?: string): Promise<void> {
  const config = readConfigFile();
  if (!config) {
    console.error("No config found. Run `arinova-bridge setup` first.");
    process.exit(1);
  }

  const enabledProviders = config.providers.filter((p) => p.enabled);
  if (enabledProviders.length === 0) {
    console.error("No providers enabled in config.");
    process.exit(1);
  }

  // Filter to providers that support login
  const loginable = enabledProviders.filter((p) => loginStrategy(p) !== "none");

  let target: ProviderEntry;

  if (providerId) {
    // Direct provider ID specified
    const found = enabledProviders.find((p) => p.id === providerId);
    if (!found) {
      console.error(`Provider "${providerId}" not found or not enabled.`);
      console.error(`Available: ${enabledProviders.map((p) => p.id).join(", ")}`);
      process.exit(1);
    }
    if (loginStrategy(found) === "none") {
      console.error(`Provider "${providerId}" uses API key auth — no OAuth login needed.`);
      console.error(`To update the API key, run \`arinova-bridge setup\` or edit config.json directly.`);
      process.exit(1);
    }
    target = found;
  } else {
    // Interactive selection
    if (loginable.length === 0) {
      console.log("No providers require OAuth login (all use API keys).");
      return;
    }

    if (loginable.length === 1) {
      target = loginable[0];
      console.log(`\nLogin: ${target.displayName}`);
    } else {
      const selected = await select<string>({
        message: "Select provider to login",
        choices: loginable.map((p) => {
          const status = getProviderStatus(p);
          return { name: `${p.displayName}${status}`, value: p.id };
        }),
      });
      target = loginable.find((p) => p.id === selected)!;
    }
  }

  const strategy = loginStrategy(target);
  switch (strategy) {
    case "minimax":
      await loginMiniMax(target);
      break;
    case "cli":
      loginCli(target);
      break;
  }
}
