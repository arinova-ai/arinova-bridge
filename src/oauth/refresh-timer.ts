import type { ProviderEntry } from "../config-file.js";
import type { Logger } from "../util/logger.js";
import { readOAuthToken, writeOAuthToken, isTokenExpired } from "./token-store.js";
import { refreshAccessToken } from "./minimax.js";

const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // Check every 4 minutes

/**
 * Start a background timer that checks and refreshes OAuth tokens.
 * Returns a cleanup function to stop the timer.
 */
export function startOAuthRefreshTimer(
  providers: ProviderEntry[],
  logger: Logger,
): () => void {
  // Find providers that need OAuth (anthropic-cli without apiKey and with baseUrl)
  const oauthProviderIds = providers
    .filter((p) => p.enabled && p.type === "anthropic-cli" && !p.apiKey && p.baseUrl)
    .map((p) => p.id);

  if (oauthProviderIds.length === 0) {
    return () => {};
  }

  logger.info(`oauth-refresh: monitoring tokens for [${oauthProviderIds.join(", ")}]`);

  const timer = setInterval(async () => {
    for (const providerId of oauthProviderIds) {
      try {
        const token = readOAuthToken(providerId);
        if (!token) continue;

        if (!isTokenExpired(token)) continue;

        logger.info(`oauth-refresh: ${providerId} token expiring, refreshing...`);
        const refreshed = await refreshAccessToken(token.refreshToken);
        writeOAuthToken(providerId, refreshed);
        logger.info(`oauth-refresh: ${providerId} token refreshed (new token will be used on next session)`);
      } catch (err) {
        logger.error(`oauth-refresh: ${providerId} refresh failed: ${err}`);
      }
    }
  }, REFRESH_INTERVAL_MS);

  // Don't keep process alive just for this timer
  timer.unref();

  return () => clearInterval(timer);
}
