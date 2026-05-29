import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockReadConfigFile = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
const mockSelect = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn());
const mockReadOAuthToken = vi.hoisted(() => vi.fn(() => null));
const mockWriteOAuthToken = vi.hoisted(() => vi.fn());
const mockIsTokenExpired = vi.hoisted(() => vi.fn(() => false));
const mockPerformMiniMaxOAuth = vi.hoisted(() => vi.fn());

vi.mock("../../src/config-file.js", () => ({
  readConfigFile: mockReadConfigFile,
  resolveProviderConfigDir: (configDir: string | undefined) => configDir?.replace(/^~/, "/home/test"),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("@inquirer/prompts", () => ({
  select: mockSelect,
  confirm: mockConfirm,
}));

vi.mock("../../src/oauth/token-store.js", () => ({
  readOAuthToken: mockReadOAuthToken,
  writeOAuthToken: mockWriteOAuthToken,
  isTokenExpired: mockIsTokenExpired,
}));

vi.mock("../../src/oauth/minimax.js", () => ({
  performMiniMaxOAuth: mockPerformMiniMaxOAuth,
}));

import { runLogin } from "../../src/login.js";

function createConfig(providers: Array<Record<string, unknown>>) {
  return {
    version: 2,
    arinova: { serverUrl: "wss://test", botToken: "ari_test" },
    defaultProvider: providers[0]?.id ?? "openai-oauth",
    providers,
    defaults: {},
  };
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

describe("login", () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arinova-login-test-"));
    mockSpawnSync.mockReturnValue({ status: 0 });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it("logs into openai-cli providers with CODEX_HOME from configDir", async () => {
    const configDir = path.join(tmpDir, "openai-oauth2");
    mockReadConfigFile.mockReturnValue(createConfig([
      {
        id: "openai-oauth2",
        type: "openai-cli",
        displayName: "OpenAI OAuth 2",
        enabled: true,
        configDir,
      },
    ]));

    await runLogin("openai-oauth2");

    expect(fs.existsSync(configDir)).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "codex",
      ["auth", "login"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({ CODEX_HOME: configDir }),
      }),
    );
  });

  it("logs into anthropic-cli providers with CLAUDE_CONFIG_DIR from configDir", async () => {
    const configDir = path.join(tmpDir, "anthropic-oauth2");
    mockReadConfigFile.mockReturnValue(createConfig([
      {
        id: "anthropic-oauth2",
        type: "anthropic-cli",
        displayName: "Anthropic OAuth 2",
        enabled: true,
        configDir,
      },
    ]));

    await runLogin("anthropic-oauth2");

    expect(fs.existsSync(configDir)).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      ["login"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: configDir }),
      }),
    );
  });

  it("shows OpenAI login status from configured auth path", async () => {
    const configDir = path.join(tmpDir, "openai-oauth2");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token",
          id_token: fakeJwt({ email: "oauth2@example.com" }),
        },
      }),
      "utf-8",
    );
    mockReadConfigFile.mockReturnValue(createConfig([
      {
        id: "openai-oauth2",
        type: "openai-cli",
        displayName: "OpenAI OAuth 2",
        enabled: true,
        configDir,
      },
      {
        id: "anthropic-oauth2",
        type: "anthropic-cli",
        displayName: "Anthropic OAuth 2",
        enabled: true,
        configDir: path.join(tmpDir, "anthropic-oauth2"),
      },
    ]));
    mockSelect.mockResolvedValue("openai-oauth2");

    await runLogin();

    expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
      choices: expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining("oauth2@example.com"),
          value: "openai-oauth2",
        }),
      ]),
    }));
  });

  // --- Error cases for runLogin ---

  it("exits when no config found", async () => {
    mockReadConfigFile.mockReturnValue(null);

    await expect(runLogin()).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when no providers are enabled", async () => {
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "p1", type: "anthropic-cli", displayName: "P1", enabled: false },
    ]));

    await expect(runLogin()).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when providerId not found in enabled providers", async () => {
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "p1", type: "anthropic-cli", displayName: "P1", enabled: true },
    ]));

    await expect(runLogin("nonexistent")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when providerId targets an API-key-only provider", async () => {
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "apikey-prov", type: "anthropic-cli", displayName: "API Key Only", enabled: true, apiKey: "sk-123" },
    ]));

    await expect(runLogin("apikey-prov")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // --- Interactive selection paths ---

  it("returns early when no providers require OAuth login", async () => {
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "apikey-prov", type: "anthropic-cli", displayName: "API Key Only", enabled: true, apiKey: "sk-123" },
    ]));

    // No providerId means interactive mode; all providers are API-key-only
    await runLogin();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("auto-selects the single loginable provider without prompting", async () => {
    const configDir = path.join(tmpDir, "solo-provider");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "solo", type: "anthropic-cli", displayName: "Solo Provider", enabled: true, configDir },
    ]));

    await runLogin();

    // Should not call select since there's only one loginable provider
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      ["login"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  // --- loginCli with deviceAuth option ---

  it("passes --device-auth flag for openai-cli when deviceAuth option is true", async () => {
    const configDir = path.join(tmpDir, "openai-device");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "openai-dev", type: "openai-cli", displayName: "OpenAI Device", enabled: true, configDir },
    ]));

    await runLogin("openai-dev", { deviceAuth: true });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "codex",
      ["auth", "login", "--device-auth"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("uses custom codexPath when provided", async () => {
    const configDir = path.join(tmpDir, "openai-custom");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "openai-custom", type: "openai-cli", displayName: "OpenAI Custom", enabled: true, configDir, codexPath: "/usr/local/bin/my-codex" },
    ]));

    await runLogin("openai-custom");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/my-codex",
      ["auth", "login"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("uses custom claudePath when provided", async () => {
    const configDir = path.join(tmpDir, "anthropic-custom");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "anth-custom", type: "anthropic-cli", displayName: "Anthropic Custom", enabled: true, configDir, claudePath: "/opt/bin/my-claude" },
    ]));

    await runLogin("anth-custom");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "/opt/bin/my-claude",
      ["login"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  // --- loginCli error handling ---

  it("exits when spawnSync returns an error", async () => {
    const configDir = path.join(tmpDir, "spawn-error");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "err-prov", type: "anthropic-cli", displayName: "Error Provider", enabled: true, configDir },
    ]));
    mockSpawnSync.mockReturnValue({ status: null, error: new Error("ENOENT") });

    await expect(runLogin("err-prov")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when spawnSync returns non-zero exit code", async () => {
    const configDir = path.join(tmpDir, "nonzero-exit");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "nz-prov", type: "anthropic-cli", displayName: "NonZero Provider", enabled: true, configDir },
    ]));
    mockSpawnSync.mockReturnValue({ status: 1 });

    await expect(runLogin("nz-prov")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // --- loginMiniMax flow ---

  it("runs MiniMax OAuth flow for anthropic-cli with baseUrl", async () => {
    const fakeToken = { accessToken: "at", refreshToken: "rt", expiresAt: 9999999999 };
    mockPerformMiniMaxOAuth.mockResolvedValue(fakeToken);
    mockSelect.mockResolvedValue("global");
    mockReadOAuthToken.mockReturnValue(null);

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "minimax-prov", type: "anthropic-cli", displayName: "MiniMax", enabled: true, baseUrl: "https://api.minimax.io" },
    ]));

    await runLogin("minimax-prov");

    // select called for region
    expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("MiniMax"),
    }));
    expect(mockPerformMiniMaxOAuth).toHaveBeenCalledWith("global");
    expect(mockWriteOAuthToken).toHaveBeenCalledWith("minimax-prov", fakeToken);
  });

  it("skips MiniMax re-login when existing token is valid and user declines", async () => {
    const existingToken = { accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    mockReadOAuthToken.mockReturnValue(existingToken);
    mockIsTokenExpired.mockReturnValue(false);
    mockConfirm.mockResolvedValue(false);

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "minimax-prov", type: "anthropic-cli", displayName: "MiniMax", enabled: true, baseUrl: "https://api.minimax.io" },
    ]));

    await runLogin("minimax-prov");

    expect(mockConfirm).toHaveBeenCalled();
    expect(mockPerformMiniMaxOAuth).not.toHaveBeenCalled();
  });

  it("re-runs MiniMax OAuth when existing token valid but user confirms re-login", async () => {
    const existingToken = { accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    mockReadOAuthToken.mockReturnValue(existingToken);
    mockIsTokenExpired.mockReturnValue(false);
    mockConfirm.mockResolvedValue(true);
    mockSelect.mockResolvedValue("cn");
    const newToken = { accessToken: "new-at", refreshToken: "new-rt", expiresAt: 9999999999 };
    mockPerformMiniMaxOAuth.mockResolvedValue(newToken);

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "minimax-prov", type: "anthropic-cli", displayName: "MiniMax", enabled: true, baseUrl: "https://api.minimax.io" },
    ]));

    await runLogin("minimax-prov");

    expect(mockPerformMiniMaxOAuth).toHaveBeenCalledWith("cn");
    expect(mockWriteOAuthToken).toHaveBeenCalledWith("minimax-prov", newToken);
  });

  // --- checkCliLoginStatus via getProviderStatus (exercised in interactive mode) ---

  it("shows anthropic-cli login status when provider is logged in", async () => {
    const configDir = path.join(tmpDir, "anth-status");
    mockSpawnSync
      // First call: checkCliLoginStatus for anthropic (called by getProviderStatus)
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ loggedIn: true, email: "user@anthropic.com" }),
      })
      // Second call: actual login spawnSync (openai-cli checkCliLoginStatus uses fs, not spawnSync)
      .mockReturnValueOnce({ status: 0 });

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "anth-prov", type: "anthropic-cli", displayName: "Anthropic", enabled: true, configDir },
      { id: "openai-prov", type: "openai-cli", displayName: "OpenAI", enabled: true, configDir: path.join(tmpDir, "openai-status") },
    ]));
    mockSelect.mockResolvedValue("anth-prov");

    await runLogin();

    expect(mockSelect).toHaveBeenCalledWith(expect.objectContaining({
      choices: expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining("user@anthropic.com"),
          value: "anth-prov",
        }),
      ]),
    }));
  });

  // --- getProviderStatus for minimax strategy ---

  it("shows minimax provider status with valid token", async () => {
    const validToken = { accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) + 86400 };
    mockReadOAuthToken.mockReturnValue(validToken);
    mockIsTokenExpired.mockReturnValue(false);

    // Two minimax providers so interactive select is triggered
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "mm1", type: "anthropic-cli", displayName: "MiniMax 1", enabled: true, baseUrl: "https://api.minimax.io" },
      { id: "mm2", type: "anthropic-cli", displayName: "MiniMax 2", enabled: true, baseUrl: "https://api.minimax.io" },
    ]));

    // First select: provider picker, second select: region
    mockSelect
      .mockResolvedValueOnce("mm1")
      .mockResolvedValueOnce("global");
    // confirm for re-login (since token exists and is valid)
    mockConfirm.mockResolvedValue(true);
    const fakeToken = { accessToken: "at", refreshToken: "rt", expiresAt: 9999999999 };
    mockPerformMiniMaxOAuth.mockResolvedValue(fakeToken);

    await runLogin();

    // The first select call should contain status info with "valid until"
    const selectCall = mockSelect.mock.calls[0][0];
    const firstChoice = selectCall.choices.find((c: { value: string }) => c.value === "mm1");
    expect(firstChoice.name).toMatch(/valid until/);
  });

  it("shows minimax provider status with expired token", async () => {
    const expiredToken = { accessToken: "at", refreshToken: "rt", expiresAt: Math.floor(Date.now() / 1000) - 3600 };
    mockReadOAuthToken.mockReturnValue(expiredToken);
    mockIsTokenExpired.mockReturnValue(true);

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "mm1", type: "anthropic-cli", displayName: "MiniMax 1", enabled: true, baseUrl: "https://api.minimax.io" },
      { id: "mm2", type: "anthropic-cli", displayName: "MiniMax 2", enabled: true, baseUrl: "https://api.minimax.io" },
    ]));

    mockSelect
      .mockResolvedValueOnce("mm1")
      .mockResolvedValueOnce("global");
    const fakeToken = { accessToken: "at", refreshToken: "rt", expiresAt: 9999999999 };
    mockPerformMiniMaxOAuth.mockResolvedValue(fakeToken);

    await runLogin();

    const selectCall = mockSelect.mock.calls[0][0];
    const firstChoice = selectCall.choices.find((c: { value: string }) => c.value === "mm1");
    expect(firstChoice.name).toMatch(/expired/);
  });

  it("shows minimax provider status as not logged in when no token", async () => {
    mockReadOAuthToken.mockReturnValue(null);

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "mm1", type: "anthropic-cli", displayName: "MiniMax 1", enabled: true, baseUrl: "https://api.minimax.io" },
      { id: "mm2", type: "anthropic-cli", displayName: "MiniMax 2", enabled: true, baseUrl: "https://api.minimax.io" },
    ]));

    mockSelect
      .mockResolvedValueOnce("mm1")
      .mockResolvedValueOnce("global");
    const fakeToken = { accessToken: "at", refreshToken: "rt", expiresAt: 9999999999 };
    mockPerformMiniMaxOAuth.mockResolvedValue(fakeToken);

    await runLogin();

    const selectCall = mockSelect.mock.calls[0][0];
    const firstChoice = selectCall.choices.find((c: { value: string }) => c.value === "mm1");
    expect(firstChoice.name).toMatch(/not logged in/);
  });

  // --- checkCliLoginStatus for openai-cli with access_token but no id_token ---

  it("shows openai-cli as logged in without email when no id_token", async () => {
    const configDir = path.join(tmpDir, "openai-no-id");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "access-token" } }),
      "utf-8",
    );

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "openai1", type: "openai-cli", displayName: "OpenAI 1", enabled: true, configDir },
      { id: "openai2", type: "openai-cli", displayName: "OpenAI 2", enabled: true, configDir: path.join(tmpDir, "openai2") },
    ]));
    mockSelect.mockResolvedValue("openai1");

    await runLogin();

    const selectCall = mockSelect.mock.calls[0][0];
    const firstChoice = selectCall.choices.find((c: { value: string }) => c.value === "openai1");
    expect(firstChoice.name).toMatch(/logged in/);
  });

  // --- openai-cli checkCliLoginStatus with invalid id_token ---

  it("shows openai-cli as logged in when id_token is malformed", async () => {
    const configDir = path.join(tmpDir, "openai-bad-jwt");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token",
          id_token: "not-a-valid-jwt",
        },
      }),
      "utf-8",
    );

    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "openai-bad", type: "openai-cli", displayName: "OpenAI Bad JWT", enabled: true, configDir },
      { id: "openai-other", type: "openai-cli", displayName: "OpenAI Other", enabled: true, configDir: path.join(tmpDir, "other") },
    ]));
    mockSelect.mockResolvedValue("openai-bad");

    await runLogin();

    // Should still show "logged in" even with bad JWT (falls back)
    const selectCall = mockSelect.mock.calls[0][0];
    const choice = selectCall.choices.find((c: { value: string }) => c.value === "openai-bad");
    expect(choice.name).toMatch(/logged in/);
  });

  // --- loginCli with no configDir (no configEnv) ---

  it("does not create configDir when provider has no configDir set", async () => {
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "no-dir", type: "anthropic-cli", displayName: "No Dir", enabled: true },
    ]));

    await runLogin("no-dir");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      ["login"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  // --- loginStrategy coverage: apiKey-only provider returns "none" ---

  it("skips login for API-key-only providers in interactive mode", async () => {
    // Mix of API-key-only and loginable
    const configDir = path.join(tmpDir, "mixed");
    mockReadConfigFile.mockReturnValue(createConfig([
      { id: "apikey1", type: "anthropic-cli", displayName: "API Key 1", enabled: true, apiKey: "sk-123" },
      { id: "cli1", type: "anthropic-cli", displayName: "CLI 1", enabled: true, configDir },
    ]));

    await runLogin();

    // Only one loginable provider, auto-selects without prompt
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalled();
  });
});
