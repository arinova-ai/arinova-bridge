import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { ClaudeProcess } from "../../../src/claude/process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn() };
});

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("ClaudeProcess per-session ARINOVA_AGENT_NAME", () => {
  const mockChild = {
    pid: 999,
    killed: false,
    exitCode: null,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };

  let savedAgentName: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
    // Save and clear env to avoid inheriting from test runner
    savedAgentName = process.env.ARINOVA_AGENT_NAME;
    delete process.env.ARINOVA_AGENT_NAME;
  });

  afterEach(() => {
    // Restore env
    if (savedAgentName !== undefined) {
      process.env.ARINOVA_AGENT_NAME = savedAgentName;
    } else {
      delete process.env.ARINOVA_AGENT_NAME;
    }
  });

  it("injects ARINOVA_AGENT_NAME from agentName opt into spawned env", () => {
    const proc = new ClaudeProcess({ logger, agentName: "lucy" });
    proc.start();

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const spawnOpts = spawnCall[2] as { env: Record<string, string> };
    expect(spawnOpts.env.ARINOVA_AGENT_NAME).toBe("lucy");
  });

  it("different agents get different ARINOVA_AGENT_NAME values (not shared)", () => {
    const procLucy = new ClaudeProcess({ logger, agentName: "lucy" });
    procLucy.start();
    const lucyEnv = ((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as { env: Record<string, string> }).env;

    const procPan = new ClaudeProcess({ logger, agentName: "pan" });
    procPan.start();
    const panEnv = ((spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[1][2] as { env: Record<string, string> }).env;

    expect(lucyEnv.ARINOVA_AGENT_NAME).toBe("lucy");
    expect(panEnv.ARINOVA_AGENT_NAME).toBe("pan");
  });

  it("does not set ARINOVA_AGENT_NAME when agentName is not provided", () => {
    const proc = new ClaudeProcess({ logger });
    proc.start();

    const spawnCall = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const spawnOpts = spawnCall[2] as { env: Record<string, string> };
    expect(spawnOpts.env.ARINOVA_AGENT_NAME).toBeUndefined();
  });
});
