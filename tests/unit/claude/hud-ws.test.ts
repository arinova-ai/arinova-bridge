import { describe, it, expect } from "vitest";
import { formatModelName } from "../../../src/claude/hud-ws.js";

describe("hud-ws", () => {
  describe("formatModelName", () => {
    it("formats claude-opus-4-6", () => {
      expect(formatModelName("claude-opus-4-6")).toBe("Opus 4.6");
    });

    it("formats claude-sonnet-4-6", () => {
      expect(formatModelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    });

    it("formats claude-haiku-4-5-20251001", () => {
      expect(formatModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    });

    it("returns raw id for unknown model", () => {
      expect(formatModelName("gpt-5")).toBe("gpt-5");
    });

    it("returns empty string for empty input", () => {
      expect(formatModelName("")).toBe("");
    });
  });
});
