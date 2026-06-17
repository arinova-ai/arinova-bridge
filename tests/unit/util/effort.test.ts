import { describe, it, expect } from "vitest";
import { parseEffort, validateEffort, resolveEffortForProvider } from "../../../src/util/effort.js";

describe("parseEffort", () => {
  it("maps numbers 1-5 onto the canonical levels", () => {
    expect(parseEffort(1)).toBe("low");
    expect(parseEffort(2)).toBe("medium");
    expect(parseEffort(3)).toBe("high");
    expect(parseEffort(4)).toBe("xhigh");
    expect(parseEffort(5)).toBe("max");
  });

  it("accepts numeric strings", () => {
    expect(parseEffort("1")).toBe("low");
    expect(parseEffort("5")).toBe("max");
  });

  it("accepts level names case-insensitively (including codex-only minimal)", () => {
    expect(parseEffort("low")).toBe("low");
    expect(parseEffort("MAX")).toBe("max");
    expect(parseEffort("Minimal")).toBe("minimal");
    expect(parseEffort("xhigh")).toBe("xhigh");
  });

  it("returns null for unset or out-of-range / unknown values", () => {
    expect(parseEffort(undefined)).toBeNull();
    expect(parseEffort(null)).toBeNull();
    expect(parseEffort("")).toBeNull();
    expect(parseEffort(0)).toBeNull();
    expect(parseEffort(6)).toBeNull();
    expect(parseEffort("turbo")).toBeNull();
  });
});

describe("validateEffort", () => {
  it("returns the canonical level for valid input", () => {
    expect(validateEffort(5)).toBe("max");
    expect(validateEffort("minimal")).toBe("minimal");
  });

  it("returns undefined when unset", () => {
    expect(validateEffort(undefined)).toBeUndefined();
    expect(validateEffort("")).toBeUndefined();
  });

  it("throws a helpful error on an invalid value", () => {
    expect(() => validateEffort(6, "defaults.effort")).toThrow(/defaults\.effort/);
    expect(() => validateEffort("turbo")).toThrow(/1-5 or one of/);
  });
});

describe("resolveEffortForProvider", () => {
  it("passes claude (anthropic-cli) the full 1-5 range", () => {
    expect(resolveEffortForProvider(1, "anthropic-cli")).toBe("low");
    expect(resolveEffortForProvider(3, "anthropic-cli")).toBe("high");
    expect(resolveEffortForProvider(4, "anthropic-cli")).toBe("xhigh");
    expect(resolveEffortForProvider(5, "anthropic-cli")).toBe("max");
    expect(resolveEffortForProvider("max", "anthropic-cli")).toBe("max");
  });

  it("clamps 'minimal' up to 'low' for claude (no minimal level)", () => {
    expect(resolveEffortForProvider("minimal", "anthropic-cli")).toBe("low");
  });

  it("maps codex (openai-cli) up to its ceiling of 'xhigh', clamping only 'max'", () => {
    expect(resolveEffortForProvider(1, "openai-cli")).toBe("low");
    expect(resolveEffortForProvider(2, "openai-cli")).toBe("medium");
    expect(resolveEffortForProvider(3, "openai-cli")).toBe("high");
    expect(resolveEffortForProvider(4, "openai-cli")).toBe("xhigh");
    expect(resolveEffortForProvider(5, "openai-cli")).toBe("xhigh"); // max → xhigh
    expect(resolveEffortForProvider("max", "openai-cli")).toBe("xhigh");
  });

  it("clamps 'minimal' up to 'low' for codex (no current model advertises minimal — it 400s)", () => {
    expect(resolveEffortForProvider("minimal", "openai-cli")).toBe("low");
  });

  it("passes the canonical level through for an unknown provider", () => {
    expect(resolveEffortForProvider(5, "some-future-provider")).toBe("max");
  });

  it("returns undefined when unset or unparseable", () => {
    expect(resolveEffortForProvider(undefined, "anthropic-cli")).toBeUndefined();
    expect(resolveEffortForProvider("turbo", "openai-cli")).toBeUndefined();
  });
});
