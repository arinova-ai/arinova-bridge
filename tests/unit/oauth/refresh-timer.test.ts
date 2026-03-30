import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/oauth/token-store.js", () => ({
  readOAuthToken: vi.fn(),
  writeOAuthToken: vi.fn(),
  isTokenExpired: vi.fn(),
}));

vi.mock("../../../src/oauth/minimax.js", () => ({
  refreshAccessToken: vi.fn(),
}));

import { startOAuthRefreshTimer } from "../../../src/oauth/refresh-timer.js";
import { readOAuthToken, writeOAuthToken, isTokenExpired } from "../../../src/oauth/token-store.js";
import { refreshAccessToken } from "../../../src/oauth/minimax.js";
import type { ProviderEntry } from "../../../src/config-file.js";

const mockReadOAuthToken = vi.mocked(readOAuthToken);
const mockWriteOAuthToken = vi.mocked(writeOAuthToken);
const mockIsTokenExpired = vi.mocked(isTokenExpired);
const mockRefreshAccessToken = vi.mocked(refreshAccessToken);

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("oauth/refresh-timer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns noop when no OAuth providers", () => {
    const providers: ProviderEntry[] = [
      { id: "api", type: "anthropic-sdk", displayName: "SDK", enabled: true, apiKey: "sk-test" },
    ];

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    expect(typeof stop).toBe("function");
    stop(); // should not throw
  });

  it("returns noop when providers have apiKey (not OAuth)", () => {
    const providers: ProviderEntry[] = [
      { id: "mm", type: "anthropic-cli", displayName: "MiniMax", enabled: true, apiKey: "key", baseUrl: "https://api.minimax.io" },
    ];

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    stop();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("identifies OAuth providers (anthropic-cli + no apiKey + baseUrl)", () => {
    const providers: ProviderEntry[] = [
      { id: "mm-oauth", type: "anthropic-cli", displayName: "MiniMax OAuth", enabled: true, baseUrl: "https://api.minimax.io" },
    ];

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("mm-oauth"));
    stop();
  });

  it("refreshes expired token on timer tick", async () => {
    const providers: ProviderEntry[] = [
      { id: "mm-oauth", type: "anthropic-cli", displayName: "MiniMax OAuth", enabled: true, baseUrl: "https://api.minimax.io" },
    ];

    const oldToken = {
      accessToken: "old",
      refreshToken: "rt-123",
      expiresAt: Date.now() / 1000 - 100,
    };
    const newToken = {
      accessToken: "new",
      refreshToken: "rt-456",
      expiresAt: Date.now() / 1000 + 3600,
    };

    mockReadOAuthToken.mockReturnValue(oldToken as never);
    mockIsTokenExpired.mockReturnValue(true);
    mockRefreshAccessToken.mockResolvedValue(newToken as never);

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);

    // Advance past the 4-minute interval
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

    expect(mockReadOAuthToken).toHaveBeenCalledWith("mm-oauth");
    expect(mockIsTokenExpired).toHaveBeenCalledWith(oldToken);
    expect(mockRefreshAccessToken).toHaveBeenCalledWith("rt-123");
    expect(mockWriteOAuthToken).toHaveBeenCalledWith("mm-oauth", newToken);

    stop();
  });

  it("skips refresh when token is not expired", async () => {
    const providers: ProviderEntry[] = [
      { id: "mm-oauth", type: "anthropic-cli", displayName: "MiniMax OAuth", enabled: true, baseUrl: "https://api.minimax.io" },
    ];

    mockReadOAuthToken.mockReturnValue({ accessToken: "valid", refreshToken: "rt", expiresAt: 0 } as never);
    mockIsTokenExpired.mockReturnValue(false);

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    stop();
  });

  it("skips when no token exists", async () => {
    const providers: ProviderEntry[] = [
      { id: "mm-oauth", type: "anthropic-cli", displayName: "MiniMax OAuth", enabled: true, baseUrl: "https://api.minimax.io" },
    ];

    mockReadOAuthToken.mockReturnValue(null);

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

    expect(mockIsTokenExpired).not.toHaveBeenCalled();
    stop();
  });

  it("logs error when refresh fails", async () => {
    const providers: ProviderEntry[] = [
      { id: "mm-oauth", type: "anthropic-cli", displayName: "MiniMax OAuth", enabled: true, baseUrl: "https://api.minimax.io" },
    ];

    mockReadOAuthToken.mockReturnValue({ accessToken: "old", refreshToken: "rt", expiresAt: 0 } as never);
    mockIsTokenExpired.mockReturnValue(true);
    mockRefreshAccessToken.mockRejectedValue(new Error("network error"));

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("refresh failed"));
    stop();
  });

  it("stop function clears the interval", async () => {
    const providers: ProviderEntry[] = [
      { id: "mm-oauth", type: "anthropic-cli", displayName: "MiniMax OAuth", enabled: true, baseUrl: "https://api.minimax.io" },
    ];

    mockReadOAuthToken.mockReturnValue({ accessToken: "old", refreshToken: "rt", expiresAt: 0 } as never);
    mockIsTokenExpired.mockReturnValue(true);
    mockRefreshAccessToken.mockResolvedValue({ accessToken: "new", refreshToken: "rt2", expiresAt: 0 } as never);

    const stop = startOAuthRefreshTimer(providers, mockLogger as never);
    stop();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });
});
