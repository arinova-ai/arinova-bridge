import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockReadConfigFile = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
const mockSelect = vi.hoisted(() => vi.fn());

vi.mock("../../src/config-file.js", () => ({
  readConfigFile: mockReadConfigFile,
  resolveProviderConfigDir: (configDir: string | undefined) => configDir?.replace(/^~/, "/home/test"),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("@inquirer/prompts", () => ({
  select: mockSelect,
  confirm: vi.fn(),
}));

vi.mock("../../src/oauth/token-store.js", () => ({
  readOAuthToken: vi.fn(() => null),
  writeOAuthToken: vi.fn(),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../src/oauth/minimax.js", () => ({
  performMiniMaxOAuth: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arinova-login-test-"));
    mockSpawnSync.mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});
