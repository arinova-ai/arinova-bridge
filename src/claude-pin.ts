import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code CLI version pinning.
 *
 * The bridge's PTY parser is calibrated against a specific Claude CLI build.
 * To keep behaviour reproducible we copy the chosen version's binary into a
 * bridge-owned location and point `claudePath` at it. The version intent
 * lives in `package.json` (so it ships with the bridge code); the binary
 * itself is too large to bundle, so users run `arinova-bridge pin-claude`
 * to materialise it from their local install.
 *
 * On disk (defaults):
 *   ~/.arinova-bridge/vendor/claude-<version>   ← pinned binary (chmod +x)
 *
 * The "current local install" we copy from is Anthropic's installer path:
 *   ~/.local/share/claude/versions/<version>
 */

export interface ClaudePinOptions {
  /** Override the Anthropic installer dir (for tests). */
  anthropicVersionsDir?: string;
  /** Override the bridge vendor dir (for tests). */
  vendorDir?: string;
}

export interface PinResult {
  version: string;
  pinnedPath: string;
  bytesCopied: number;
}

export const DEFAULT_VENDOR_DIR = path.join(homedir(), ".arinova-bridge", "vendor");
export const DEFAULT_ANTHROPIC_VERSIONS_DIR = path.join(
  homedir(),
  ".local",
  "share",
  "claude",
  "versions",
);

/**
 * Read the pinned Claude version declared in this bridge build's
 * package.json. Returns null if the field (or the file) is missing.
 * Searches up from the current module file — works for both compiled
 * (dist/claude-pin.js) and tsx-dev (src/claude-pin.ts) layouts.
 */
export function readPinnedVersion(): string | null {
  const here = new URL(import.meta.url).pathname;
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf-8"));
        if (pkg.name === "@arinova-ai/arinova-bridge") {
          return pkg.arinovaBridge?.pinnedClaudeVersion ?? null;
        }
      } catch {
        // continue searching upward
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate the source binary for `version` under the Anthropic install dir.
 * Returns the absolute path, or null if absent.
 */
export function findInstalledClaudeBinary(
  version: string,
  opts?: ClaudePinOptions,
): string | null {
  const baseDir = opts?.anthropicVersionsDir ?? DEFAULT_ANTHROPIC_VERSIONS_DIR;
  const candidate = path.join(baseDir, version);
  try {
    const st = fs.statSync(candidate);
    if (st.isFile()) return candidate;
  } catch {
    // not found
  }
  return null;
}

/**
 * Where a pinned version *would* live, regardless of whether it has been
 * materialised. Use `validatePinnedBinary` for an existence check.
 */
export function getPinnedClaudePath(version: string, opts?: ClaudePinOptions): string {
  const dir = opts?.vendorDir ?? DEFAULT_VENDOR_DIR;
  return path.join(dir, `claude-${version}`);
}

/**
 * True if `pinnedPath` exists, is a regular file, and is owner-executable.
 */
export function validatePinnedBinary(pinnedPath: string): boolean {
  try {
    const st = fs.statSync(pinnedPath);
    if (!st.isFile()) return false;
    return (st.mode & 0o100) !== 0; // owner-execute bit
  } catch {
    return false;
  }
}

export class ClaudeBinaryNotFoundError extends Error {
  readonly version: string;
  readonly lookedAt: string;
  constructor(version: string, lookedAt: string) {
    super(
      `Claude Code ${version} not found at ${lookedAt}. ` +
        `Install Claude Code at this version (the bridge's pinned version ` +
        `lives in package.json -> arinovaBridge.pinnedClaudeVersion), then ` +
        `re-run \`arinova-bridge pin-claude\`.`,
    );
    this.name = "ClaudeBinaryNotFoundError";
    this.version = version;
    this.lookedAt = lookedAt;
  }
}

/**
 * Copy `version` from the Anthropic install dir into the bridge vendor dir.
 * Idempotent — overwrites any existing copy. Callers update `config.json`
 * afterwards (we do not touch config here so the function stays unit-test
 * friendly).
 */
export function pinClaudeBinary(version: string, opts?: ClaudePinOptions): PinResult {
  const source = findInstalledClaudeBinary(version, opts);
  if (!source) {
    const baseDir = opts?.anthropicVersionsDir ?? DEFAULT_ANTHROPIC_VERSIONS_DIR;
    throw new ClaudeBinaryNotFoundError(version, path.join(baseDir, version));
  }
  const vendorDir = opts?.vendorDir ?? DEFAULT_VENDOR_DIR;
  fs.mkdirSync(vendorDir, { recursive: true });
  const dest = getPinnedClaudePath(version, opts);
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
  const st = fs.statSync(dest);
  return { version, pinnedPath: dest, bytesCopied: st.size };
}
