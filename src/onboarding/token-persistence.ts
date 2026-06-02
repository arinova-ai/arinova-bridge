import { readConfigFile, writeConfigFile, type ConfigFile } from "../config-file.js";
import type { Logger } from "../util/logger.js";

/**
 * Persist the permanent `ari_*` token to config.json, replacing the
 * one-time onboarding claim token so the bridge uses it on restart.
 */
export function savePermanentToken(token: string, logger: Logger): void {
  const existing = readConfigFile();

  if (existing) {
    existing.arinova.botToken = token;
    writeConfigFile(existing);
  } else {
    const config: ConfigFile = {
      version: 2,
      arinova: {
        serverUrl: "wss://api.chat.arinova.ai",
        botToken: token,
      },
      defaultProvider: "anthropic-oauth",
      providers: [],
      defaults: {},
    };
    writeConfigFile(config);
  }

  logger.info("Permanent token saved to config.json");
}
