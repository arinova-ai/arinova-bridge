#!/usr/bin/env node

import fs from "node:fs";
import { homedir } from "node:os";
import { input, select, checkbox, password, confirm } from "@inquirer/prompts";
import { writeConfigFile, readConfigFile, getConfigPath, type ConfigFile } from "./config-file.js";

type ProviderId = "anthropic-api" | "anthropic-oauth" | "openai-api" | "openai-oauth";

const PROVIDER_CHOICES: Array<{ name: string; value: ProviderId; description: string }> = [
  { name: "Anthropic API", value: "anthropic-api", description: "Claude Code SDK, API 計費" },
  { name: "Anthropic OAuth", value: "anthropic-oauth", description: "claude CLI, Max/Pro 訂閱" },
  { name: "OpenAI API", value: "openai-api", description: "codex CLI + API key" },
  { name: "OpenAI OAuth", value: "openai-oauth", description: "codex CLI + OAuth" },
];

function maskToken(token: string): string {
  if (token.length <= 12) return "****";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
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
  const enabledProviders = await checkbox<ProviderId>({
    message: "Enable providers (space to toggle, enter to confirm)",
    choices: PROVIDER_CHOICES.map((p) => ({
      name: `${p.name}  (${p.description})`,
      value: p.value,
      checked: existing
        ? (existing.providers?.[p.value]?.enabled ?? false)
        : (p.value === "anthropic-oauth"),
    })),
    validate: (selected) => {
      if (selected.length === 0) return "At least one provider must be enabled";
      return true;
    },
  });

  // Step 3: API Key Prompts (only for API providers)
  const config: ConfigFile = {
    version: 1,
    arinova: { botToken },
    defaultProvider: enabledProviders[0],
    providers: {},
    defaults: {},
  };

  for (const id of enabledProviders) {
    if (id === "anthropic-api") {
      const apiKey = await password({
        message: "Anthropic API Key (sk-ant-...)",
        mask: "*",
      });
      const defaultModel = await input({
        message: "Default model",
        default: existing?.providers?.["anthropic-api"]?.defaultModel ?? "sonnet",
      });
      config.providers["anthropic-api"] = {
        enabled: true,
        apiKey: apiKey || undefined,
        defaultModel: defaultModel || undefined,
      };
    } else if (id === "anthropic-oauth") {
      config.providers["anthropic-oauth"] = { enabled: true };
    } else if (id === "openai-api") {
      const apiKey = await password({
        message: "OpenAI API Key (sk-...)",
        mask: "*",
      });
      config.providers["openai-api"] = {
        enabled: true,
        apiKey: apiKey || undefined,
      };
    } else if (id === "openai-oauth") {
      config.providers["openai-oauth"] = { enabled: true };
    }
  }

  // Step 4: Default Provider
  if (enabledProviders.length > 1) {
    const defaultProvider = await select<string>({
      message: "Default provider",
      choices: enabledProviders.map((id) => {
        const info = PROVIDER_CHOICES.find((p) => p.value === id)!;
        return { name: `${info.name}  (${info.description})`, value: id };
      }),
      default: existing?.defaultProvider && enabledProviders.includes(existing.defaultProvider as ProviderId)
        ? existing.defaultProvider
        : enabledProviders[0],
    });
    config.defaultProvider = defaultProvider;
  }

  // Step 5: Working Directory
  const defaultCwd = await input({
    message: "Default working directory",
    default: existing?.defaults?.cwd ?? "~/projects",
  });
  config.defaults.cwd = defaultCwd;

  // Step 6: Confirmation Summary
  console.log("\n──────────────────────────────────────");
  console.log("  Token:     " + maskToken(config.arinova.botToken));
  console.log("  Providers: " + enabledProviders.join(", "));
  console.log("  Default:   " + config.defaultProvider);
  console.log("  CWD:       " + config.defaults.cwd);
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
  writeConfigFile(config);
  console.log(`\n✓ Saved to ${getConfigPath()}`);
  console.log("\nYou can now start the bridge with:");
  console.log("  npm start");
  console.log("  # or");
  console.log("  npx arinova-bridge");
  return true;
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
