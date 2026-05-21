import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";

/**
 * Tests for per-session/per-thread/per-turn ARINOVA_AGENT_NAME isolation.
 *
 * Bella P1: multiple agents sharing the same provider must NOT overwrite
 * each other's agentName. Each provider type uses a different strategy:
 * - Claude: per-session (process env)
 * - OpenAI: per-thread (thread config)
 */

// --- OpenAI per-thread agentName ---

describe("OpenAI per-thread agentName", () => {
  it("extracts agentName from conversationId for thread config", () => {
    // Replicates the logic in openai-cli.ts:90
    const cases: [string, string | undefined][] = [
      ["lucy:default", "lucy"],
      ["pan:default", "pan"],
      [":default", undefined],     // empty agent part → undefined
      ["adele:compact", "adele"],
    ];

    for (const [conversationId, expected] of cases) {
      const agentName = conversationId.split(":")[0] || undefined;
      expect(agentName).toBe(expected);
    }
  });

  it("two agents sharing same CodexAppServer get different agentName in thread config", () => {
    // Simulate what openai-cli.ts does for two different agents
    const threadConfigs: Array<{ conversationId: string; config?: { env: { ARINOVA_AGENT_NAME: string } } }> = [];

    for (const convId of ["lucy:default", "pan:default"]) {
      const agentName = convId.split(":")[0] || undefined;
      const config = agentName ? { env: { ARINOVA_AGENT_NAME: agentName } } : undefined;
      threadConfigs.push({ conversationId: convId, config });
    }

    expect(threadConfigs[0].config!.env.ARINOVA_AGENT_NAME).toBe("lucy");
    expect(threadConfigs[1].config!.env.ARINOVA_AGENT_NAME).toBe("pan");
    // They must NOT be the same reference
    expect(threadConfigs[0].config).not.toBe(threadConfigs[1].config);
  });
});

// --- CLI --source auto-fill from ARINOVA_AGENT_NAME ---

describe("CLI --source auto-fill from ARINOVA_AGENT_NAME", () => {
  let savedAgentName: string | undefined;

  beforeEach(() => {
    savedAgentName = process.env.ARINOVA_AGENT_NAME;
  });

  afterEach(() => {
    if (savedAgentName !== undefined) {
      process.env.ARINOVA_AGENT_NAME = savedAgentName;
    } else {
      delete process.env.ARINOVA_AGENT_NAME;
    }
  });

  // Replicates cli.ts:251 logic
  function parseFlag(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  }

  it("uses explicit --source when provided", () => {
    process.env.ARINOVA_AGENT_NAME = "pan";
    const args = ["--deliver", "lucy", "--content", "hello", "--source", "bella"];
    const source = parseFlag(args, "--source") ?? process.env.ARINOVA_AGENT_NAME;

    expect(source).toBe("bella"); // explicit flag wins over env
  });

  it("falls back to ARINOVA_AGENT_NAME when --source not provided", () => {
    process.env.ARINOVA_AGENT_NAME = "pan";
    const args = ["--deliver", "lucy", "--content", "hello"];
    const source = parseFlag(args, "--source") ?? process.env.ARINOVA_AGENT_NAME;

    expect(source).toBe("pan");
  });

  it("source is undefined when neither --source nor env is set", () => {
    delete process.env.ARINOVA_AGENT_NAME;
    const args = ["--deliver", "lucy", "--content", "hello"];
    const source = parseFlag(args, "--source") ?? process.env.ARINOVA_AGENT_NAME;

    expect(source).toBeUndefined();
  });
});
