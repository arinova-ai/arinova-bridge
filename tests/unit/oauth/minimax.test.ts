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
