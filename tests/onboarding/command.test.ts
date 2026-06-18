import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Test the pure/filesystem parts of the onboarding command.
// Network-dependent claimToken and interactive prompts are not unit-tested here.

describe("onboarding/command config writers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-cmd-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mergeJsonConfig(filePath: string, key: string, value: Record<string, unknown>): string {
    const dir = path.dirname(filePath);
    let config: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      try {
        config = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `Cannot parse ${filePath} — fix the JSON manually or remove the file.\n` +
          `Parse error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    const existing = (config[key] ?? {}) as Record<string, unknown>;
    config[key] = { ...existing, ...value };
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return filePath;
  }

  it("creates config file when none exists", () => {
    const target = path.join(tmpDir, "settings.json");
    mergeJsonConfig(target, "mcpServers", {
      arinova: { command: "npx", args: ["-y", "@arinova-ai/mcp-server@latest"] },
    });

    const written = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(written.mcpServers.arinova.command).toBe("npx");
    expect(written.mcpServers.arinova.args).toContain("@arinova-ai/mcp-server@latest");
  });

  it("merges into existing config without overwriting other keys", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({
      theme: "dark",
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    }, null, 2));

    mergeJsonConfig(target, "mcpServers", {
      arinova: { command: "npx", args: ["-y", "@arinova-ai/mcp-server@latest"] },
    });

    const written = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.github).toBeDefined();
    expect(written.mcpServers.arinova).toBeDefined();
  });

  it("overwrites existing arinova entry on re-run", () => {
    const target = path.join(tmpDir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({
      mcpServers: {
        arinova: { command: "old", args: [] },
      },
    }));

    mergeJsonConfig(target, "mcpServers", {
      arinova: { command: "npx", args: ["-y", "@arinova-ai/mcp-server@latest"] },
    });

    const written = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(written.mcpServers.arinova.command).toBe("npx");
  });

  it("creates nested directories for config path", () => {
    const target = path.join(tmpDir, "deep", "nested", "mcp.json");
    mergeJsonConfig(target, "mcpServers", { arinova: { command: "test" } });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("throws on malformed existing JSON instead of silently overwriting", () => {
    const target = path.join(tmpDir, "broken.json");
    fs.writeFileSync(target, "{ not valid json !!!");

    expect(() =>
      mergeJsonConfig(target, "mcpServers", { arinova: { command: "test" } }),
    ).toThrow(/Cannot parse.*broken\.json/);

    // Original file must be untouched
    expect(fs.readFileSync(target, "utf-8")).toBe("{ not valid json !!!");
  });
});

describe("parseTokenFlag", () => {
  function parseTokenFlag(args: string[]): string | undefined {
    for (const arg of args) {
      if (arg.startsWith("--token=")) return arg.slice("--token=".length);
    }
    const idx = args.indexOf("--token");
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return undefined;
  }

  it("parses --token=value format", () => {
    expect(parseTokenFlag(["--token=obt_abc123"])).toBe("obt_abc123");
  });

  it("parses --token value format", () => {
    expect(parseTokenFlag(["--token", "obt_abc123"])).toBe("obt_abc123");
  });

  it("returns undefined when missing", () => {
    expect(parseTokenFlag(["--other", "value"])).toBeUndefined();
  });

  it("returns undefined for --token at end of args", () => {
    expect(parseTokenFlag(["--token"])).toBeUndefined();
  });
});
