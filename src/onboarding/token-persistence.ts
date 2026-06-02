import { readConfigFile, writeConfigFile, type ConfigFile } from "../config-file.js";
import type { Logger } from "../util/logger.js";

/**
 * Persist the permanent `ari_*` token to config.json, replacing the
 * one-time onboarding claim token so the bridge uses it on restart.
 *
 * Updates both the top-level `arinova.botToken` and the matching entry
 * in `config.agents` (if multi-agent mode is configured).
 */
export function savePermanentToken(token: string, logger: Logger, agentName?: string): void {
  const existing = readConfigFile();

  if (existing) {
    existing.arinova.botToken = token;

    if (existing.agents && agentName) {
      const entry = existing.agents.find((a) => a.name === agentName);
      if (entry) {
        entry.botToken = token;
      }
    }

    writeConfigFile(existing);
  } else {
    const config: ConfigFile = {
      version: 2,
      arinova: {
        serverUrl: "wss://api.chat.arinova.ai",
        botToken: token,
      },
      defaultProvider: "anthropic-oauth",
      providers: [
        {
          id: "anthropic-oauth",
          type: "anthropic-cli",
          displayName: "Claude (onboarding)",
          enabled: true,
        },
      ],
      defaults: {},
    };
    writeConfigFile(config);
  }

  logger.info("Permanent token saved to config.json");
}
