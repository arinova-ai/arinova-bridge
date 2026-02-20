import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("token-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arinova-test-tokens-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadModule() {
    vi.doMock("../../../src/config-file.js", () => ({
      getConfigDir: () => tmpDir,
    }));
    const mod = await import("../../../src/oauth/token-store.js");
    return mod;
  }

  it("returns null when tokens file does not exist", async () => {
    const { readOAuthToken } = await loadModule();
    expect(readOAuthToken("minimax-oauth")).toBeNull();
  });

  it("writes and reads token for a provider", async () => {
    const { readOAuthToken, writeOAuthToken } = await loadModule();

    const token = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: 1700000000,
    };

    writeOAuthToken("minimax-oauth", token);

    const result = readOAuthToken("minimax-oauth");
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("access-123");
    expect(result!.refreshToken).toBe("refresh-456");
    expect(result!.expiresAt).toBe(1700000000);
  });

  it("preserves other providers when writing", async () => {
    const { readOAuthToken, writeOAuthToken } = await loadModule();

    writeOAuthToken("provider-a", {
      accessToken: "a", refreshToken: "ra", expiresAt: 100,
    });
    writeOAuthToken("provider-b", {
      accessToken: "b", refreshToken: "rb", expiresAt: 200,
    });

    expect(readOAuthToken("provider-a")!.accessToken).toBe("a");
    expect(readOAuthToken("provider-b")!.accessToken).toBe("b");
  });

  it("returns null for unknown provider", async () => {
    const { readOAuthToken, writeOAuthToken } = await loadModule();

    writeOAuthToken("minimax-oauth", {
      accessToken: "a", refreshToken: "r", expiresAt: 100,
    });

    expect(readOAuthToken("nonexistent")).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const { readOAuthToken } = await loadModule();
    fs.writeFileSync(path.join(tmpDir, "tokens.json"), "not json{{{", "utf-8");

    expect(readOAuthToken("minimax-oauth")).toBeNull();
  });

  it("sets file permissions to 0600", async () => {
    const { writeOAuthToken } = await loadModule();

    writeOAuthToken("test", {
      accessToken: "a", refreshToken: "r", expiresAt: 100,
    });

    const stat = fs.statSync(path.join(tmpDir, "tokens.json"));
    // Check owner-only read/write (0600 = 0o600 = 384 decimal)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  describe("isTokenExpired", () => {
    it("returns false for future token", async () => {
      const { isTokenExpired } = await loadModule();
      const futureToken = {
        accessToken: "a", refreshToken: "r",
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      };
      expect(isTokenExpired(futureToken)).toBe(false);
    });

    it("returns true for past token", async () => {
      const { isTokenExpired } = await loadModule();
      const pastToken = {
        accessToken: "a", refreshToken: "r",
        expiresAt: Math.floor(Date.now() / 1000) - 100,
      };
      expect(isTokenExpired(pastToken)).toBe(true);
    });

    it("returns true when within threshold", async () => {
      const { isTokenExpired } = await loadModule();
      const soonToken = {
        accessToken: "a", refreshToken: "r",
        expiresAt: Math.floor(Date.now() / 1000) + 60, // 1 minute from now
      };
      // Default threshold is 5 min (300s), so 60s away → expired
      expect(isTokenExpired(soonToken)).toBe(true);
    });

    it("respects custom threshold", async () => {
      const { isTokenExpired } = await loadModule();
      const token = {
        accessToken: "a", refreshToken: "r",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      };
      // 30s threshold → 60s away → not expired
      expect(isTokenExpired(token, 30_000)).toBe(false);
    });
  });
});
