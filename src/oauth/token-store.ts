import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config-file.js";

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp in seconds */
  expiresAt: number;
}

const TOKENS_FILE = "tokens.json";

function getTokensPath(): string {
  return path.join(getConfigDir(), TOKENS_FILE);
}

function readAllTokens(): Record<string, OAuthToken> | null {
  const p = getTokensPath();
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as Record<string, OAuthToken>;
  } catch {
    return null;
  }
}

export function readOAuthToken(providerId: string): OAuthToken | null {
  const all = readAllTokens();
  return all?.[providerId] ?? null;
}

export function writeOAuthToken(providerId: string, token: OAuthToken): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const all = readAllTokens() ?? {};
  all[providerId] = token;

  const p = getTokensPath();
  fs.writeFileSync(p, JSON.stringify(all, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Check if token is expired or will expire within the threshold.
 * @param thresholdMs - milliseconds before expiry to consider "expired" (default 5 min)
 */
export function isTokenExpired(token: OAuthToken, thresholdMs = 300_000): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  const thresholdSec = Math.floor(thresholdMs / 1000);
  return token.expiresAt - nowSec < thresholdSec;
}
