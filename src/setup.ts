#!/usr/bin/env node

import readline from "node:readline";
import { writeConfigFile, readConfigFile, getConfigPath, type ConfigFile } from "./config-file.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue = ""): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function askToggle(
  label: string,
  defaultEnabled: boolean,
): Promise<boolean> {
  const hint = defaultEnabled ? "[Y/n]" : "[y/N]";
  const answer = await ask(`  Enable ${label}? ${hint}`, defaultEnabled ? "y" : "n");
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function main() {
  console.log("\n=== Arinova Bridge Setup ===\n");

  const existing = readConfigFile();
  if (existing) {
    console.log(`Found existing config at ${getConfigPath()}`);
    const overwrite = await ask("Overwrite? [y/N]", "n");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Setup cancelled.");
      rl.close();
      return;
    }
    console.log();
  }

  // Step 1: Arinova Server Connection
  console.log("Step 1: Arinova Server Connection");
  const serverUrl = await ask("  Server URL", existing?.arinova?.serverUrl ?? "ws://localhost:3501");
  const botToken = await askSecret("  Bot Token");
  if (!botToken) {
    console.error("Bot token is required.");
    rl.close();
    process.exit(1);
  }
  console.log();

  // Step 2: Configure Providers
  console.log("Step 2: Configure Providers");
  const enableAnthropicApi = await askToggle(
    "Anthropic API Key (Claude Code SDK, API 計費)",
    existing?.providers?.["anthropic-api"]?.enabled ?? false,
  );
  const enableAnthropicOauth = await askToggle(
    "Anthropic OAuth (claude CLI, Max/Pro 訂閱)",
    existing?.providers?.["anthropic-oauth"]?.enabled ?? true,
  );
  const enableOpenaiApi = await askToggle(
    "OpenAI API Key (codex CLI + API key)",
    existing?.providers?.["openai-api"]?.enabled ?? false,
  );
  const enableOpenaiOauth = await askToggle(
    "OpenAI OAuth (codex CLI + OAuth)",
    existing?.providers?.["openai-oauth"]?.enabled ?? false,
  );
  console.log();

  // Step 3: Provider Details
  const config: ConfigFile = {
    version: 1,
    arinova: { serverUrl, botToken },
    defaultProvider: "anthropic-oauth",
    providers: {},
    defaults: {},
  };

  if (enableAnthropicApi) {
    console.log("Step 3a: Anthropic API Details");
    const apiKey = await askSecret("  API Key (sk-ant-...)");
    const defaultModel = await ask("  Default model", "sonnet");
    config.providers["anthropic-api"] = {
      enabled: true,
      apiKey: apiKey || undefined,
      defaultModel: defaultModel || undefined,
    };
    console.log();
  }

  if (enableAnthropicOauth) {
    console.log("Step 3b: Anthropic OAuth Details");
    const claudePath = await ask("  Path to claude binary", "claude");
    config.providers["anthropic-oauth"] = {
      enabled: true,
      claudePath: claudePath !== "claude" ? claudePath : undefined,
    };
    console.log();
  }

  if (enableOpenaiApi) {
    console.log("Step 3c: OpenAI API Details");
    const apiKey = await askSecret("  API Key (sk-...)");
    const codexPath = await ask("  Path to codex binary", "codex");
    config.providers["openai-api"] = {
      enabled: true,
      apiKey: apiKey || undefined,
      codexPath: codexPath !== "codex" ? codexPath : undefined,
    };
    console.log();
  }

  if (enableOpenaiOauth) {
    console.log("Step 3d: OpenAI OAuth Details");
    const codexPath = await ask("  Path to codex binary", "codex");
    config.providers["openai-oauth"] = {
      enabled: true,
      codexPath: codexPath !== "codex" ? codexPath : undefined,
    };
    console.log();
  }

  // Step 4: Defaults
  console.log("Step 4: Defaults");

  // Determine default provider
  const enabledProviders: string[] = [];
  if (enableAnthropicApi) enabledProviders.push("anthropic-api");
  if (enableAnthropicOauth) enabledProviders.push("anthropic-oauth");
  if (enableOpenaiApi) enabledProviders.push("openai-api");
  if (enableOpenaiOauth) enabledProviders.push("openai-oauth");

  if (enabledProviders.length === 0) {
    console.error("At least one provider must be enabled.");
    rl.close();
    process.exit(1);
  }

  const defaultProvider = await ask(
    `  Default provider (${enabledProviders.join(" / ")})`,
    enabledProviders[0],
  );
  if (!enabledProviders.includes(defaultProvider)) {
    console.error(`Invalid provider: ${defaultProvider}`);
    rl.close();
    process.exit(1);
  }
  config.defaultProvider = defaultProvider;

  const defaultCwd = await ask("  Default working directory", "~/projects");
  config.defaults.cwd = defaultCwd;

  console.log();

  // Write config
  writeConfigFile(config);
  console.log(`✓ Saved to ${getConfigPath()}`);
  console.log();
  console.log("You can now start the bridge with:");
  console.log("  npm start");
  console.log("  # or");
  console.log("  npx arinova-bridge");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
