import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { input, select, checkbox, password, confirm } from "@inquirer/prompts";
import { writeConfigFile, readConfigFile, getConfigPath, type ConfigFile, type ProviderEntry } from "./config-file.js";
import { readOAuthToken, writeOAuthToken, isTokenExpired } from "./oauth/token-store.js";
import { performMiniMaxOAuth, type MiniMaxRegion } from "./oauth/minimax.js";

interface BuiltinProvider {
  id: string;
  type: string;
  displayName: string;
  needsApiKey: boolean;
  needsOAuth?: boolean;
  apiKeyPrompt?: string;
  baseUrl?: string;
  models?: string[];
}

const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  {
    id: "anthropic-oauth",
    type: "anthropic-cli",
    displayName: "Anthropic OAuth (Claude CLI)",
    needsApiKey: false,
    models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  },
  {
    id: "anthropic-api",
    type: "anthropic-sdk",
    displayName: "Anthropic API (Claude Code SDK)",
    needsApiKey: true,
    apiKeyPrompt: "Anthropic API Key (sk-ant-...)",
  },
  {
    id: "openai-oauth",
    type: "openai-cli",
    displayName: "OpenAI OAuth (Codex CLI)",
    needsApiKey: false,
  },
  {
    id: "gemini-oauth",
    type: "gemini-cli",
    displayName: "Google Gemini (OAuth)",
    needsApiKey: false,
    models: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  {
    id: "google-api",
    type: "gemini-cli",
    displayName: "Google Gemini API (Gemini CLI)",
    needsApiKey: true,
    apiKeyPrompt: "Google Gemini API Key",
    models: ["gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  {
    id: "openai-api",
    type: "openai-cli",
    displayName: "OpenAI API (Codex CLI)",
    needsApiKey: true,
    apiKeyPrompt: "OpenAI API Key (sk-...)",
  },
  {
    id: "minimax-oauth",
    type: "anthropic-cli",
    displayName: "MiniMax OAuth (Coding Plan)",
    needsApiKey: false,
    needsOAuth: true,
    baseUrl: "https://api.minimax.io/anthropic",
    models: ["MiniMax-M2.5", "MiniMax-M2.1"],
  },
  {
    id: "minimax-api",
    type: "anthropic-cli",
    displayName: "MiniMax API (Anthropic Compatible)",
    needsApiKey: true,
    apiKeyPrompt: "MiniMax API Key",
    baseUrl: "https://api.minimax.io/anthropic",
    models: ["MiniMax-M2.5", "MiniMax-M2.1"],
  },
  {
    id: "zhipu-api",
    type: "anthropic-cli",
    displayName: "Zhipu API (Anthropic Compatible)",
    needsApiKey: true,
    apiKeyPrompt: "Zhipu API Key",
    baseUrl: "https://api.z.ai/api/anthropic",
    models: ["GLM-4.7", "GLM-4.5-Air", "GLM-5"],
  },
];

function maskToken(token: string): string {
  if (token.length <= 12) return "****";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

function getExistingEntry(existing: ConfigFile | null, id: string): ProviderEntry | undefined {
  return existing?.providers?.find((p) => p.id === id);
}

async function handleOAuthLogin(builtin: BuiltinProvider): Promise<void> {
  // Check for existing valid token
  const existingToken = readOAuthToken(builtin.id);
  if (existingToken && !isTokenExpired(existingToken)) {
    const expiresDate = new Date(existingToken.expiresAt * 1000).toLocaleString();
    console.log(`\n${builtin.displayName}: 已有有效 token（到期: ${expiresDate}）`);
    const relogin = await confirm({ message: "重新登入？", default: false });
    if (!relogin) return;
  }

  // Region selection
  const region = await select<MiniMaxRegion>({
    message: `${builtin.displayName} Region`,
    choices: [
      { name: "Global (api.minimax.io)", value: "global" },
      { name: "China (api.minimaxi.com)", value: "cn" },
    ],
    default: "global",
  });

  try {
    const token = await performMiniMaxOAuth(region);
    writeOAuthToken(builtin.id, token);
    console.log(`\n✓ ${builtin.displayName} OAuth 登入成功`);
  } catch (err) {
    console.error(`\n✗ ${builtin.displayName} OAuth 登入失敗: ${err}`);
    const skip = await confirm({ message: "跳過此 provider？", default: true });
    if (!skip) throw err;
  }
}

async function runSetup(): Promise<boolean> {
  console.log("\n=== Arinova Bridge Setup ===\n");

  const existing = readConfigFile();
  if (existing) {
    console.log(`Found existing config at ${getConfigPath()}`);
    const overwrite = await confirm({ message: "Overwrite?", default: false });
    if (!overwrite) {
      console.log("Setup cancelled.");
      return true;
    }
    console.log();
  }

  // Step 1: Bot Token
  const existingToken = existing?.arinova?.botToken;
  const botToken = await password({
    message: existingToken
      ? `Bot Token (current: ${maskToken(existingToken)})`
      : "Bot Token",
    mask: "*",
    validate: (val) => {
      if (!val && !existingToken) return "Bot token is required";
      return true;
    },
  }) || existingToken!;

  // Step 2: Provider Selection
  const enabledIds = await checkbox<string>({
    message: "Enable providers (space to toggle, enter to confirm)",
    choices: BUILTIN_PROVIDERS.map((p) => ({
      name: `${p.displayName}`,
      value: p.id,
      checked: existing
        ? !!getExistingEntry(existing, p.id)?.enabled
        : (p.id === "anthropic-oauth"),
    })),
    validate: (selected) => {
      if (selected.length === 0) return "At least one provider must be enabled";
      return true;
    },
  });

  // Step 3: API Key Prompts (per provider)
  const providers: ProviderEntry[] = [];

  for (const id of enabledIds) {
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id)!;
    const existingEntry = getExistingEntry(existing, id);

    const entry: ProviderEntry = {
      id: builtin.id,
      type: builtin.type,
      displayName: builtin.displayName,
      enabled: true,
    };

    if (builtin.baseUrl) {
      entry.baseUrl = builtin.baseUrl;
    }
    if (builtin.models) {
      entry.models = builtin.models;
    }

    if (builtin.needsApiKey) {
      const existingKey = existingEntry?.apiKey;
      const apiKey = await password({
        message: existingKey
          ? `${builtin.apiKeyPrompt} (current: ${maskToken(existingKey)})`
          : (builtin.apiKeyPrompt ?? `${builtin.displayName} API Key`),
        mask: "*",
      }) || existingKey;
      if (apiKey) {
        entry.apiKey = apiKey;
      }
    }

    if (builtin.needsOAuth) {
      await handleOAuthLogin(builtin);
    }

    providers.push(entry);
  }

  // Step 4: Default Provider
  let defaultProvider = enabledIds[0];
  if (enabledIds.length > 1) {
    defaultProvider = await select<string>({
      message: "Default provider",
      choices: providers.map((p) => ({
        name: p.displayName,
        value: p.id,
      })),
      default: existing?.defaultProvider && enabledIds.includes(existing.defaultProvider)
        ? existing.defaultProvider
        : enabledIds[0],
    });
  }

  // Step 5: Working Directory
  const defaultCwd = await input({
    message: "Default working directory",
    default: existing?.defaults?.cwd ?? "~/projects",
  });

  // Step 6: Confirmation Summary
  console.log("\n──────────────────────────────────────");
  console.log("  Token:     " + maskToken(botToken));
  console.log("  Providers: " + providers.map((p) => p.id).join(", "));
  console.log("  Default:   " + defaultProvider);
  console.log("  CWD:       " + defaultCwd);
  console.log("──────────────────────────────────────\n");

  const confirmed = await confirm({ message: "Save this configuration?", default: true });
  if (!confirmed) {
    console.log("\nRestarting setup...\n");
    return false;
  }

  // Step 7: Ensure working directory exists
  const resolvedCwd = defaultCwd.replace(/^~/, homedir());
  if (!fs.existsSync(resolvedCwd)) {
    fs.mkdirSync(resolvedCwd, { recursive: true });
    console.log(`\n✓ Created directory: ${resolvedCwd}`);
  }

  // Step 8: Write config
  const config: ConfigFile = {
    version: 2,
    arinova: { botToken },
    defaultProvider,
    providers,
    defaults: { cwd: defaultCwd },
  };

  writeConfigFile(config);
  console.log(`\n✓ Saved to ${getConfigPath()}`);

  // Step 9: Claude statusLine setup for rate limit monitoring
  const hasAnthropicCli = providers.some((p) => p.type === "anthropic-cli");
  if (hasAnthropicCli) {
    await setupClaudeStatusLine();
  }

  console.log("\nYou can now start the bridge with:");
  console.log("  arinova-bridge start");
  return true;
}

const CLAUDE_SETTINGS_PATH = path.join(homedir(), ".claude", "settings.json");
const STATUS_LINE_CMD = "tee /tmp/claude-status.json";

async function setupClaudeStatusLine(): Promise<void> {
  console.log("\n── Rate Limit Monitoring ──────────────");

  const enableHud = await confirm({
    message: "啟用 rate limit 監控？（需設定 Claude CLI statusLine）",
    default: true,
  });
  if (!enableHud) return;

  // Read existing settings
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
    } catch {
      console.log("  ⚠ 無法解析現有 settings.json，將建立新的");
      settings = {};
    }
  }

  // Check existing statusLine
  if (settings.statusLine && settings.statusLine !== STATUS_LINE_CMD) {
    console.log(`  現有 statusLine: ${settings.statusLine}`);
    const overwrite = await confirm({
      message: "覆寫現有 statusLine 設定？",
      default: false,
    });
    if (!overwrite) {
      console.log("  跳過 statusLine 設定");
      return;
    }
  }

  // Merge and write
  settings.statusLine = STATUS_LINE_CMD;

  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`\n✓ Claude statusLine 已設定（${CLAUDE_SETTINGS_PATH}）`);
  console.log("  Rate limit 資料將寫入 /tmp/claude-status.json");
}

async function main() {
  let done = false;
  while (!done) {
    done = await runSetup();
  }
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
