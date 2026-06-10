import { describe, it, expect } from "vitest";
import { contextWindowFor } from "../../../src/claude/pty-process.js";

describe("contextWindowFor", () => {
  it("matches full dated model ids", () => {
    expect(contextWindowFor("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-5-20250929")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-6")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowFor("claude-fable-5")).toBe(1_000_000);
  });

  it("matches aliases and statusline display names", () => {
    expect(contextWindowFor("haiku")).toBe(200_000);
    expect(contextWindowFor("Haiku 4.5")).toBe(200_000);
    expect(contextWindowFor("Opus 4.8")).toBe(1_000_000);
    expect(contextWindowFor("Sonnet 4.6")).toBe(1_000_000);
  });

  it("matches older models at 200K", () => {
    expect(contextWindowFor("claude-opus-4-20250514")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-4-20250514")).toBe(200_000);
  });

  // Regression: the old exact-id table fabricated { contextWindow: 100 }
  // on a lookup miss, which made needsCompact's threshold ~50 tokens and
  // auto-compacted (an invisible multi-second extra turn, no streaming)
  // after EVERY message — the chat sat stuck in "streaming" until the
  // compact turn finished.
  it("never returns a tiny window for unknown models", () => {
    for (const id of ["", "unknown-model", "gpt-9", "Claude X"]) {
      expect(contextWindowFor(id)).toBeGreaterThanOrEqual(200_000);
    }
  });
});
