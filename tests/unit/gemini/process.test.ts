import { describe, it, expect, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

import { resolveGeminiBinary, interruptGeminiProcess } from "../../../src/gemini/process.js";
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const mockExecSync = vi.mocked(execSync);

describe("gemini/process", () => {
  describe("resolveGeminiBinary", () => {
    it("returns envPath when provided", () => {
      expect(resolveGeminiBinary("/usr/local/bin/gemini")).toBe("/usr/local/bin/gemini");
    });

    it("falls back to which gemini", () => {
      mockExecSync.mockReturnValue("/opt/homebrew/bin/gemini\n");
      expect(resolveGeminiBinary()).toBe("/opt/homebrew/bin/gemini");
    });

    it("throws when gemini not found", () => {
      mockExecSync.mockImplementation(() => { throw new Error("not found"); });
      expect(() => resolveGeminiBinary()).toThrow("Gemini binary not found");
    });
  });

  describe("interruptGeminiProcess", () => {
    it("sends SIGINT to running process", () => {
      const mockChild = { killed: false, pid: 1234, kill: vi.fn() } as unknown as ChildProcess;
      interruptGeminiProcess(mockChild);
      expect(mockChild.kill).toHaveBeenCalledWith("SIGINT");
    });

    it("does nothing for already killed process", () => {
      const mockChild = { killed: true, pid: 1234, kill: vi.fn() } as unknown as ChildProcess;
      interruptGeminiProcess(mockChild);
      expect(mockChild.kill).not.toHaveBeenCalled();
    });

    it("does nothing for process without pid", () => {
      const mockChild = { killed: false, pid: undefined, kill: vi.fn() } as unknown as ChildProcess;
      interruptGeminiProcess(mockChild);
      expect(mockChild.kill).not.toHaveBeenCalled();
    });
  });
});
