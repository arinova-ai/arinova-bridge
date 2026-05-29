import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// We test the module directly — mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  generatePKCE,
  requestDeviceCode,
  pollForToken,
  refreshAccessToken,
  performMiniMaxOAuth,
} from "../../../src/oauth/minimax.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generatePKCE", () => {
  it("generates verifier and challenge", () => {
    const { verifier, challenge } = generatePKCE();
    expect(verifier).toHaveLength(43); // 32 bytes → base64url = 43 chars
    expect(challenge).toBeTruthy();
    expect(challenge).not.toBe(verifier);
  });

  it("challenge is SHA256 of verifier", () => {
    const { verifier, challenge } = generatePKCE();
    const expected = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generates unique pairs", () => {
    const a = generatePKCE();
    const b = generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("requestDeviceCode", () => {
  it("sends correct request and returns device code", async () => {
    const state = crypto.randomBytes(16).toString("base64url");
    // We can't predict the state, so we capture it from the request
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          user_code: "ABC-1234",
          verification_uri: "https://minimax.io/verify",
          expired_in: Date.now() + 300_000,
          interval: 3,
          state: body.get("state"),
        }),
      };
    });

    const result = await requestDeviceCode("global");

    expect(result.deviceCode.userCode).toBe("ABC-1234");
    expect(result.deviceCode.verificationUri).toBe("https://minimax.io/verify");
    expect(result.deviceCode.interval).toBe(3);
    expect(result.verifier).toHaveLength(43);

    // Verify correct endpoint was called
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.minimax.io/oauth/code",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses China endpoint for cn region", async () => {
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          user_code: "XYZ-5678",
          verification_uri: "https://minimaxi.com/verify",
          expired_in: Date.now() + 300_000,
          interval: 2,
          state: body.get("state"),
        }),
      };
    });

    const result = await requestDeviceCode("cn");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.minimaxi.com/oauth/code",
      expect.anything(),
    );
    expect(result.deviceCode.userCode).toBe("XYZ-5678");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      text: async () => "invalid client",
    });

    await expect(requestDeviceCode()).rejects.toThrow("MiniMax OAuth code request failed");
  });

  it("throws on state mismatch", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        user_code: "ABC",
        verification_uri: "https://example.com",
        expired_in: Date.now() + 300_000,
        state: "wrong-state",
      }),
    });

    await expect(requestDeviceCode()).rejects.toThrow("state mismatch");
  });

  it("throws with data.error when response is incomplete and error is present", async () => {
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          // missing user_code and verification_uri
          expired_in: 300,
          state: body.get("state"),
          error: "custom_error_from_server",
        }),
      };
    });

    await expect(requestDeviceCode()).rejects.toThrow("custom_error_from_server");
  });

  it("throws default message when response is incomplete and no error field", async () => {
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          // missing user_code and verification_uri
          expired_in: 300,
          state: body.get("state"),
        }),
      };
    });

    await expect(requestDeviceCode()).rejects.toThrow(
      "MiniMax OAuth returned incomplete response",
    );
  });

  it("normalizes expired_in from Unix seconds timestamp", async () => {
    const unixSeconds = 1740012345; // > 1_000_000_000 but < 1_000_000_000_000
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          user_code: "TS-1234",
          verification_uri: "https://minimax.io/verify",
          expired_in: unixSeconds,
          interval: 2,
          state: body.get("state"),
        }),
      };
    });

    const result = await requestDeviceCode();
    // Unix seconds should be converted to ms
    expect(result.deviceCode.expiresAt).toBe(unixSeconds * 1000);
  });

  it("normalizes expired_in from relative seconds", async () => {
    const relativeSeconds = 300; // < 1_000_000_000
    const nowBefore = Date.now();
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          user_code: "RS-5678",
          verification_uri: "https://minimax.io/verify",
          expired_in: relativeSeconds,
          interval: 5,
          state: body.get("state"),
        }),
      };
    });

    const result = await requestDeviceCode();
    const nowAfter = Date.now();
    // Relative seconds: expiresAt should be Date.now() + seconds*1000
    expect(result.deviceCode.expiresAt).toBeGreaterThanOrEqual(
      nowBefore + relativeSeconds * 1000,
    );
    expect(result.deviceCode.expiresAt).toBeLessThanOrEqual(
      nowAfter + relativeSeconds * 1000,
    );
  });

  it("defaults interval to 2 when not provided", async () => {
    mockFetch.mockImplementation(async (_url: string, opts: any) => {
      const body = new URLSearchParams(opts.body);
      return {
        ok: true,
        json: async () => ({
          user_code: "NO-INT",
          verification_uri: "https://minimax.io/verify",
          expired_in: Date.now() + 300_000,
          // no interval field
          state: body.get("state"),
        }),
      };
    });

    const result = await requestDeviceCode();
    expect(result.deviceCode.interval).toBe(2);
  });
});

describe("pollForToken", () => {
  it("returns token on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        status: "success",
        access_token: "at-123",
        refresh_token: "rt-456",
        expired_in: 3600,
      }),
    });

    const token = await pollForToken(
      "ABC-1234",
      "verifier123",
      Date.now() + 60_000,
      0.01, // tiny interval for fast test
    );

    expect(token.accessToken).toBe("at-123");
    expect(token.refreshToken).toBe("rt-456");
    expect(token.expiresAt).toBeGreaterThan(0);
  });

  it("polls until success after pending", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return {
          ok: true,
          text: async () => JSON.stringify({ status: "pending" }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          status: "success",
          access_token: "at-final",
          refresh_token: "rt-final",
          expired_in: 3600,
        }),
      };
    });

    const token = await pollForToken(
      "ABC",
      "verifier",
      Date.now() + 60_000,
      0.01,
    );

    expect(callCount).toBe(3);
    expect(token.accessToken).toBe("at-final");
  });

  it("throws on timeout", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ status: "pending" }),
    });

    await expect(
      pollForToken("ABC", "verifier", Date.now() - 1000, 0.01),
    ).rejects.toThrow("timed out");
  });

  it("throws on error status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ status: "error" }),
    });

    await expect(
      pollForToken("ABC", "verifier", Date.now() + 60_000, 0.01),
    ).rejects.toThrow("MiniMax OAuth error");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      text: async () => JSON.stringify({
        base_resp: { status_msg: "invalid code" },
      }),
    });

    await expect(
      pollForToken("ABC", "verifier", Date.now() + 60_000, 0.01),
    ).rejects.toThrow("invalid code");
  });

  it("throws when response is OK but body is not valid JSON", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => "this is not json",
    });

    await expect(
      pollForToken("ABC", "verifier", Date.now() + 60_000, 0.01),
    ).rejects.toThrow("MiniMax OAuth: failed to parse response");
  });

  it("throws when status is success but token fields are missing", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        status: "success",
        access_token: "at-123",
        // missing refresh_token and expired_in
      }),
    });

    await expect(
      pollForToken("ABC", "verifier", Date.now() + 60_000, 0.01),
    ).rejects.toThrow("MiniMax OAuth returned incomplete token");
  });

  it("throws on HTTP error with fallback text when no base_resp", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      text: async () => "plain error text",
    });

    await expect(
      pollForToken("ABC", "verifier", Date.now() + 60_000, 0.01),
    ).rejects.toThrow("plain error text");
  });
});

describe("refreshAccessToken", () => {
  it("refreshes token successfully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-at",
        refresh_token: "new-rt",
        expired_in: 7200,
      }),
    });

    const token = await refreshAccessToken("old-rt", "global");

    expect(token.accessToken).toBe("new-at");
    expect(token.refreshToken).toBe("new-rt");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.minimax.io/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps old refresh token if new one not provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-at",
        expired_in: 3600,
      }),
    });

    const token = await refreshAccessToken("old-rt");
    expect(token.refreshToken).toBe("old-rt");
  });

  it("uses China endpoint for cn region", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "cn-at",
        expired_in: 3600,
      }),
    });

    await refreshAccessToken("rt", "cn");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.minimaxi.com/oauth/token",
      expect.anything(),
    );
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(refreshAccessToken("bad-rt")).rejects.toThrow("refresh failed");
  });
});

describe("performMiniMaxOAuth", () => {
  it("runs the full device code flow and returns a token", async () => {
    // Suppress console.log output during this test
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    let callCount = 0;
    mockFetch.mockImplementation(async (url: string, opts: any) => {
      callCount++;
      if (url.includes("/oauth/code")) {
        // Device code request
        const body = new URLSearchParams(opts.body);
        return {
          ok: true,
          json: async () => ({
            user_code: "FLOW-1234",
            verification_uri: "https://minimax.io/verify?client=test",
            expired_in: Date.now() + 300_000,
            interval: 0.01,
            state: body.get("state"),
          }),
        };
      }
      // Token poll request
      return {
        ok: true,
        text: async () => JSON.stringify({
          status: "success",
          access_token: "flow-at",
          refresh_token: "flow-rt",
          expired_in: 3600,
        }),
      };
    });

    const token = await performMiniMaxOAuth("global");

    expect(token.accessToken).toBe("flow-at");
    expect(token.refreshToken).toBe("flow-rt");
    expect(token.expiresAt).toBeGreaterThan(0);
    // Should have called code endpoint + token endpoint
    expect(callCount).toBeGreaterThanOrEqual(2);

    logSpy.mockRestore();
  });

  it("propagates error from requestDeviceCode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockFetch.mockResolvedValue({
      ok: false,
      statusText: "Server Error",
      text: async () => "internal error",
    });

    await expect(performMiniMaxOAuth()).rejects.toThrow(
      "MiniMax OAuth code request failed",
    );

    logSpy.mockRestore();
  });
});
