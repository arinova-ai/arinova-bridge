import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("config-file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arinova-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadModule() {
    // Mock homedir BEFORE importing the module so module-level constants use tmpDir
    vi.doMock("node:os", () => ({
      ...os,
      homedir: () => tmpDir,
      default: { ...os, homedir: () => tmpDir },
    }));

    const mod = await import("../../src/config-file.js");
    return mod;
  }

  it("returns null when config file does not exist", async () => {
    const { readConfigFile } = await loadModule();
    const result = readConfigFile();
    expect(result).toBeNull();
  });

  it("writes and reads config file", async () => {
    const { readConfigFile, writeConfigFile } = await loadModule();

    writeConfigFile({
      version: 1,
      arinova: { serverUrl: "ws://localhost:3501", botToken: "test-token" },
      defaultProvider: "anthropic-oauth",
      providers: {
        "anthropic-oauth": { enabled: true },
      },
      defaults: { cwd: "~/projects" },
    });

    const result = readConfigFile();
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.arinova.serverUrl).toBe("ws://localhost:3501");
    expect(result!.defaultProvider).toBe("anthropic-oauth");
  });

  it("creates config directory if it does not exist", async () => {
    const { writeConfigFile } = await loadModule();
    const configDir = path.join(tmpDir, ".arinova-bridge");

    expect(fs.existsSync(configDir)).toBe(false);

    writeConfigFile({
      version: 1,
      arinova: { serverUrl: "ws://test", botToken: "tok" },
      defaultProvider: "anthropic-oauth",
      providers: {},
      defaults: {},
    });

    expect(fs.existsSync(configDir)).toBe(true);
  });

  it("returns null for malformed JSON", async () => {
    const { readConfigFile } = await loadModule();
    const configDir = path.join(tmpDir, ".arinova-bridge");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "not json{{{", "utf-8");

    const result = readConfigFile();
    expect(result).toBeNull();
  });
});
