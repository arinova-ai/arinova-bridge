import crypto from "node:crypto";
import type { OAuthToken } from "./token-store.js";

// --- Constants ---

const CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113";
const SCOPES = ["group_id", "profile", "model.completion"];
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:user_code";

const ENDPOINTS = {
  global: {
    code: "https://api.minimax.io/oauth/code",
    token: "https://api.minimax.io/oauth/token",
  },
  cn: {
    code: "https://api.minimaxi.com/oauth/code",
    token: "https://api.minimaxi.com/oauth/token",
  },
} as const;

export type MiniMaxRegion = "global" | "cn";

export interface DeviceCodeResponse {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

// --- PKCE ---

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// --- Device Code Request ---

export async function requestDeviceCode(
  region: MiniMaxRegion = "global",
): Promise<{ deviceCode: DeviceCodeResponse; verifier: string }> {
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("base64url");
  const endpoint = ENDPOINTS[region].code;

  const body = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MiniMax OAuth code request failed: ${text || response.statusText}`);
  }

  const data = (await response.json()) as {
    user_code: string;
    verification_uri: string;
    expired_in: number;
    interval?: number;
    state: string;
    error?: string;
  };

  if (!data.user_code || !data.verification_uri) {
    throw new Error(data.error ?? "MiniMax OAuth returned incomplete response");
  }

  if (data.state !== state) {
    throw new Error("MiniMax OAuth state mismatch");
  }

  // expired_in from MiniMax can be:
  // - absolute timestamp in ms (e.g. 1740012345678)
  // - absolute timestamp in seconds (e.g. 1740012345)
  // - relative seconds (e.g. 300)
  // Normalize to absolute ms for Date.now() comparison
  let expiresAtMs = data.expired_in;
  if (expiresAtMs < 1_000_000_000_000) {
    // Not a ms timestamp — could be seconds timestamp or relative
    if (expiresAtMs > 1_000_000_000) {
      // Looks like Unix seconds timestamp
      expiresAtMs = expiresAtMs * 1000;
    } else {
      // Relative seconds
      expiresAtMs = Date.now() + expiresAtMs * 1000;
    }
  }

  return {
    deviceCode: {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresAt: expiresAtMs,
      interval: data.interval ?? 2,
    },
    verifier,
  };
}

// --- Poll for Token ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollForToken(
  userCode: string,
  verifier: string,
  expiresAt: number,
  interval: number = 2,
  region: MiniMaxRegion = "global",
): Promise<OAuthToken> {
  const endpoint = ENDPOINTS[region].token;
  // interval from MiniMax may be in seconds or milliseconds
  // If > 100, assume it's already in ms; otherwise treat as seconds
  let pollInterval = interval > 100 ? interval : interval * 1000;
  // Clamp to 1–30 seconds
  pollInterval = Math.max(1000, Math.min(pollInterval, 30_000));

  while (Date.now() < expiresAt) {
    await sleep(pollInterval);

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      client_id: CLIENT_ID,
      user_code: userCode,
      code_verifier: verifier,
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const text = await response.text();
    console.error(`[minimax-oauth] poll response: ${text.slice(0, 200)}`);
    let data: {
      status?: string;
      access_token?: string;
      refresh_token?: string;
      expired_in?: number;
      base_resp?: { status_code?: number; status_msg?: string };
    } | undefined;

    try {
      data = JSON.parse(text);
    } catch {
      // Invalid JSON response
    }

    if (!response.ok) {
      const errorMsg = data?.base_resp?.status_msg || text || "Unknown error";
      throw new Error(`MiniMax OAuth failed: ${errorMsg}`);
    }

    if (!data) {
      throw new Error("MiniMax OAuth: failed to parse response");
    }

    if (data.status === "error") {
      throw new Error("MiniMax OAuth error. Please try again.");
    }

    if (data.status !== "success") {
      // Still pending — back off slightly
      pollInterval = Math.min(pollInterval * 1.5, 10_000);
      continue;
    }

    if (!data.access_token || !data.refresh_token || !data.expired_in) {
      throw new Error("MiniMax OAuth returned incomplete token");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expired_in,
    };
  }

  throw new Error("MiniMax OAuth timed out waiting for authorization");
}

// --- Refresh Token ---

export async function refreshAccessToken(
  refreshToken: string,
  region: MiniMaxRegion = "global",
): Promise<OAuthToken> {
  const endpoint = ENDPOINTS[region].token;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MiniMax token refresh failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expired_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + data.expired_in,
  };
}

// --- Combined Flow ---

export async function performMiniMaxOAuth(
  region: MiniMaxRegion = "global",
): Promise<OAuthToken> {
  const { deviceCode, verifier } = await requestDeviceCode(region);

  console.log("\n──────────────────────────────────────");
  console.log("  MiniMax OAuth 授權");
  console.log("──────────────────────────────────────");
  console.log(`  授權碼: ${deviceCode.userCode}`);
  // Strip client display name from URL, keep only user_code
  const url = new URL(deviceCode.verificationUri);
  url.searchParams.delete("client");
  console.log(`  網址:   ${url.toString()}`);
  console.log("──────────────────────────────────────");
  console.log("\n請在瀏覽器中開啟上述網址，輸入授權碼完成登入。");
  console.log("等待授權中...\n");

  return pollForToken(
    deviceCode.userCode,
    verifier,
    deviceCode.expiresAt,
    deviceCode.interval,
    region,
  );
}
