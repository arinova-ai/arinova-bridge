import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { input, select, password, confirm } from "@inquirer/prompts";
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
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"],
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
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.2", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"],
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

const SUBMIT_VALUE = "__submit__";

async function selectProviders(existing: ConfigFile | null): Promise<string[]> {
  const checked = new Set<string>(
    existing
      ? BUILTIN_PROVIDERS.filter((p) => getExistingEntry(existing, p.id)?.enabled).map((p) => p.id)
      : ["anthropic-oauth"],
  );

  while (true) {
    const choices = BUILTIN_PROVIDERS.map((p) => ({
      name: `${checked.has(p.id) ? "✓" : " "} ${p.displayName}`,
      value: p.id,
    }));
    choices.push({ name: `── Submit (${checked.size} selected) ──`, value: SUBMIT_VALUE });

    const picked = await select<string>({
      message: "Enable providers (enter to toggle, select Submit to confirm)",
      choices,
    });

    if (picked === SUBMIT_VALUE) {
      if (checked.size === 0) {
        console.log("  ⚠ At least one provider must be enabled");
        continue;
      }
      return Array.from(checked);
    }

    if (checked.has(picked)) {
      checked.delete(picked);
    } else {
      checked.add(picked);
    }
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

  // Step 2: Provider Selection (enter = toggle, select Submit to confirm)
  const enabledIds = await selectProviders(existing);

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
    await setupClaudePin();
  }

  console.log("\nYou can now start the bridge with:");
  console.log("  arinova-bridge start");
  return true;
}

const BRIDGE_DIR = path.join(homedir(), ".arinova-bridge");
const STATUSLINE_SCRIPT_PATH = path.join(BRIDGE_DIR, "statusline.sh");
const CLAUDE_SETTINGS_PATH = path.join(BRIDGE_DIR, "claude-settings.json");
const STATUSLINE_CONFIG = {
  type: "command",
  command: "~/.arinova-bridge/statusline.sh",
};

/* eslint-disable no-useless-escape */
// Output line is prefixed with the `__BRIDGE_HUD__` sentinel — the PTY
// parser uses it (and only it) to identify this row as UI chrome and to
// extract hud_update data. Do not change the sentinel without updating
// `terminal-parser.ts`.
const STATUSLINE_SCRIPT = [
  "#!/bin/bash",
  "INPUT=$(cat)",
  'echo "$INPUT" | /usr/bin/python3 -c "',
  "import sys, json, time",
  "d = json.load(sys.stdin)",
  "def fmt_reset(epoch):",
  "  if not epoch: return None",
  "  diff = int(epoch - time.time())",
  "  if diff <= 0: return 'reset'",
  "  days = diff // 86400; hours = (diff % 86400) // 3600; mins = (diff % 3600) // 60",
  "  parts = []",
  "  if days: parts.append(f'{days}d')",
  "  if hours: parts.append(f'{hours}h')",
  "  parts.append(f'{mins}m')",
  "  return ' '.join(parts)",
  "cw = d.get('context_window', {})",
  "ctx_pct = cw.get('used_percentage')",
  "rl = d.get('rate_limits', {})",
  "fh = rl.get('five_hour', {})",
  "sd = rl.get('seven_day', {})",
  "model = d.get('model', {})",
  "cost = d.get('cost', {})",
  "out = {",
  "  'context': {'used': ctx_pct if ctx_pct is not None else 0, 'total': cw.get('context_window_size', 0), 'percent': ctx_pct if ctx_pct is not None else 0},",
  "  'limit5h': {'percent': round(fh.get('used_percentage', 0)), 'resetIn': fmt_reset(fh.get('resets_at'))},",
  "  'limit7d': {'percent': round(sd.get('used_percentage', 0)), 'resetIn': fmt_reset(sd.get('resets_at'))},",
  "  'model': model.get('display_name', ''),",
  "  'cost': round(cost.get('total_cost_usd', 0), 4),",
  "}",
  "for k in ('limit5h', 'limit7d'):",
  "  if out[k]['resetIn'] is None: del out[k]['resetIn']",
  "json.dump(out, sys.stdout)",
  '" > /tmp/claude-status.json 2>/dev/null',
  'cat /tmp/claude-status.json | /usr/bin/python3 -c "',
  "import sys, json",
  "d = json.load(sys.stdin)",
  "ctx = d.get('context',{}).get('percent','?')",
  "r5 = d.get('limit5h',{})",
  "r7 = d.get('limit7d',{})",
  "p5 = r5.get('percent','?')",
  "p7 = r7.get('percent','?')",
  "ri5 = f\\\" ({r5['resetIn']})\\\" if r5.get('resetIn') else ''",
  "ri7 = f\\\" ({r7['resetIn']})\\\" if r7.get('resetIn') else ''",
  "model = d.get('model','') or '?'",
  "cost = d.get('cost', 0)",
  "print(f'__BRIDGE_HUD__ [{model}] ctx:{ctx}% | 5h:{p5}%{ri5} | 7d:{p7}%{ri7} | \\${cost:.3f}')",
  '" 2>/dev/null',
].join("\n") + "\n";

async function setupClaudePin(): Promise<void> {
  const { readPinnedVersion, pinClaudeBinary, ClaudeBinaryNotFoundError } = await import(
    "./claude-pin.js"
  );

  const version = readPinnedVersion();
  if (!version) return; // package.json missing the field — nothing to pin

  console.log("\n── Claude CLI 版本鎖定 ──────────────────");
  console.log(`Bridge 預期使用 Claude Code ${version}（package.json 宣告）。`);
  console.log("會把本機已安裝的 binary 複製到 ~/.arinova-bridge/vendor/ 給 bridge 專用，");
  console.log("這樣外面 claude 被 auto-updater 換版本時 bridge 不會受影響。");

  const enablePin = await confirm({
    message: `要立刻 pin Claude Code ${version} 嗎？`,
    default: true,
  });
  if (!enablePin) {
    console.log("  跳過 pin。之後可手動跑 `arinova-bridge pin-claude`。");
    return;
  }

  let result;
  try {
    result = pinClaudeBinary(version);
  } catch (err) {
    if (err instanceof ClaudeBinaryNotFoundError) {
      console.warn(`  ⚠ ${err.message}`);
      console.warn("  跳過 pin。請先安裝對應版本的 Claude Code 再跑 `arinova-bridge pin-claude`。");
      return;
    }
    throw err;
  }

  // Write claudePath back into every anthropic-cli provider.
  const config = readConfigFile();
  if (!config) return;
  let updated = 0;
  for (const provider of config.providers) {
    if (provider.type === "anthropic-cli" && provider.claudePath !== result.pinnedPath) {
      provider.claudePath = result.pinnedPath;
      updated++;
    }
  }
  if (updated > 0) writeConfigFile(config);

  console.log(`  ✓ 複製到 ${result.pinnedPath} (${Math.round(result.bytesCopied / 1024 / 1024)} MB)`);
  console.log(`  ✓ 更新 ${updated} 個 anthropic-cli provider 的 claudePath`);
}

async function setupClaudeStatusLine(): Promise<void> {
  console.log("\n── Rate Limit Monitoring ──────────────");

  const enableHud = await confirm({
    message: "啟用 rate limit 監控？",
    default: true,
  });
  if (!enableHud) return;

  if (!fs.existsSync(BRIDGE_DIR)) {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  }

  // Step 1: Create statusline.sh script
  fs.writeFileSync(STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT, { mode: 0o755 });
  console.log(`  ✓ 建立 ${STATUSLINE_SCRIPT_PATH}`);

  // Step 2: Write bridge-local Claude settings (only statusLine)
  const settings = { statusLine: STATUSLINE_CONFIG };
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`  ✓ 建立 ${CLAUDE_SETTINGS_PATH}`);
  console.log("  HUD monitor 會透過 --settings 載入，不影響使用者的 ~/.claude/settings.json");
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
