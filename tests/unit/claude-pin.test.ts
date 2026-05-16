import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findInstalledClaudeBinary,
  pinClaudeBinary,
  getPinnedClaudePath,
  validatePinnedBinary,
  ClaudeBinaryNotFoundError,
  readPinnedVersion,
} from "../../src/claude-pin.js";

// Use ephemeral dirs for both source (fake Anthropic install) and dest
// (fake bridge vendor). Each test creates its own pair under os.tmpdir().
let anthropicVersionsDir: string;
let vendorDir: string;
let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pin-test-"));
  anthropicVersionsDir = path.join(testRoot, "anthropic", "versions");
  vendorDir = path.join(testRoot, "bridge", "vendor");
  fs.mkdirSync(anthropicVersionsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function writeFakeBinary(version: string, contents = "#!/bin/sh\necho fake claude\n"): string {
  const p = path.join(anthropicVersionsDir, version);
  fs.writeFileSync(p, contents);
  fs.chmodSync(p, 0o755);
  return p;
}

describe("findInstalledClaudeBinary", () => {
  it("returns the path when the version file exists", () => {
    const p = writeFakeBinary("2.1.143");
    expect(findInstalledClaudeBinary("2.1.143", { anthropicVersionsDir })).toBe(p);
  });

  it("returns null when the version file does not exist", () => {
    expect(findInstalledClaudeBinary("9.9.9", { anthropicVersionsDir })).toBeNull();
  });

  it("returns null when the path points at a directory rather than a file", () => {
    fs.mkdirSync(path.join(anthropicVersionsDir, "2.1.143"));
    expect(findInstalledClaudeBinary("2.1.143", { anthropicVersionsDir })).toBeNull();
  });
});

describe("pinClaudeBinary", () => {
  it("copies the version binary into the vendor dir and marks it executable", () => {
    const sourcePath = writeFakeBinary("2.1.143", "#!/bin/sh\necho hello-pinned\n");
    const result = pinClaudeBinary("2.1.143", { anthropicVersionsDir, vendorDir });

    expect(result.version).toBe("2.1.143");
    expect(result.pinnedPath).toBe(path.join(vendorDir, "claude-2.1.143"));
    expect(result.bytesCopied).toBe(fs.statSync(sourcePath).size);

    const destStat = fs.statSync(result.pinnedPath);
    expect(destStat.isFile()).toBe(true);
    expect(destStat.mode & 0o100).not.toBe(0); // owner-executable
    expect(fs.readFileSync(result.pinnedPath, "utf-8")).toBe("#!/bin/sh\necho hello-pinned\n");
  });

  it("is idempotent — re-pinning the same version overwrites cleanly", () => {
    writeFakeBinary("2.1.143", "first\n");
    pinClaudeBinary("2.1.143", { anthropicVersionsDir, vendorDir });

    writeFakeBinary("2.1.143", "second\n"); // simulate source replaced (rare but possible)
    const result2 = pinClaudeBinary("2.1.143", { anthropicVersionsDir, vendorDir });

    expect(fs.readFileSync(result2.pinnedPath, "utf-8")).toBe("second\n");
  });

  it("creates the vendor dir if it does not exist", () => {
    writeFakeBinary("2.1.143");
    expect(fs.existsSync(vendorDir)).toBe(false);
    pinClaudeBinary("2.1.143", { anthropicVersionsDir, vendorDir });
    expect(fs.existsSync(vendorDir)).toBe(true);
  });

  it("supports multiple versions side by side", () => {
    writeFakeBinary("2.1.142", "v142\n");
    writeFakeBinary("2.1.143", "v143\n");

    pinClaudeBinary("2.1.142", { anthropicVersionsDir, vendorDir });
    pinClaudeBinary("2.1.143", { anthropicVersionsDir, vendorDir });

    expect(fs.readFileSync(path.join(vendorDir, "claude-2.1.142"), "utf-8")).toBe("v142\n");
    expect(fs.readFileSync(path.join(vendorDir, "claude-2.1.143"), "utf-8")).toBe("v143\n");
  });

  it("throws ClaudeBinaryNotFoundError with the expected lookedAt path when source is missing", () => {
    expect(() => pinClaudeBinary("nope", { anthropicVersionsDir, vendorDir })).toThrow(
      ClaudeBinaryNotFoundError,
    );
    try {
      pinClaudeBinary("nope", { anthropicVersionsDir, vendorDir });
    } catch (err) {
      const e = err as ClaudeBinaryNotFoundError;
      expect(e.version).toBe("nope");
      expect(e.lookedAt).toBe(path.join(anthropicVersionsDir, "nope"));
    }
  });
});

describe("getPinnedClaudePath", () => {
  it("returns the vendor path even when the binary has not been materialised", () => {
    const p = getPinnedClaudePath("2.1.143", { vendorDir });
    expect(p).toBe(path.join(vendorDir, "claude-2.1.143"));
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe("validatePinnedBinary", () => {
  it("returns true for an executable regular file", () => {
    writeFakeBinary("2.1.143");
    const result = pinClaudeBinary("2.1.143", { anthropicVersionsDir, vendorDir });
    expect(validatePinnedBinary(result.pinnedPath)).toBe(true);
  });

  it("returns false for a non-existent path", () => {
    expect(validatePinnedBinary(path.join(vendorDir, "ghost"))).toBe(false);
  });

  it("returns false for a regular file without the owner-execute bit", () => {
    const p = path.join(testRoot, "non-exec");
    fs.writeFileSync(p, "");
    fs.chmodSync(p, 0o644);
    expect(validatePinnedBinary(p)).toBe(false);
  });

  it("returns false for a directory", () => {
    expect(validatePinnedBinary(testRoot)).toBe(false);
  });
});

describe("readPinnedVersion", () => {
  it("reads the version from the bridge's own package.json", () => {
    // The test runs inside the bridge repo, so this should resolve to the
    // current declared pin. The exact value isn't important — just that it
    // returns a non-null version string.
    const v = readPinnedVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
