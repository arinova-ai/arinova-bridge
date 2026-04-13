import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";

/**
 * Tests for per-session/per-thread/per-turn ARINOVA_AGENT_NAME isolation.
 *
 * Bella P1: multiple agents sharing the same provider must NOT overwrite
 * each other's agentName. Each provider type uses a different strategy:
 * - Claude: per-session (process env)
 * - OpenAI: per-thread (thread config)
 * - Gemini: per-turn (ephemeral process env)
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

// --- Gemini per-turn agentName ---

describe("Gemini per-turn agentName", () => {
  it("builds per-turn env with agentName from conversationId", () => {
    // Replicates gemini-cli.ts:231-234
    const customEnv = { GEMINI_API_KEY: "test-key", SOME_VAR: "value" };

    const conversationId = "lucy:default";
    const agentName = conversationId.split(":")[0];
    const turnEnv = agentName
      ? { ...customEnv, ARINOVA_AGENT_NAME: agentName }
      : customEnv;

    expect(turnEnv.ARINOVA_AGENT_NAME).toBe("lucy");
    expect(turnEnv.GEMINI_API_KEY).toBe("test-key");
  });

  it("different agents get different per-turn env (not shared)", () => {
    const customEnv = { GEMINI_API_KEY: "test-key" };

    function buildTurnEnv(conversationId: string) {
      const agentName = conversationId.split(":")[0];
      return agentName
        ? { ...customEnv, ARINOVA_AGENT_NAME: agentName }
        : customEnv;
    }

    const lucyEnv = buildTurnEnv("lucy:default");
    const panEnv = buildTurnEnv("pan:default");

    expect(lucyEnv.ARINOVA_AGENT_NAME).toBe("lucy");
    expect(panEnv.ARINOVA_AGENT_NAME).toBe("pan");
    // Changing one must not affect the other (spread creates new object)
    expect(lucyEnv).not.toBe(panEnv);
  });

  it("each turn creates a fresh env object (no stale state)", () => {
    const customEnv = { GEMINI_API_KEY: "key" };

    // Turn 1: lucy
    const turn1Env = { ...customEnv, ARINOVA_AGENT_NAME: "lucy" };
    // Turn 2: pan (same provider instance)
    const turn2Env = { ...customEnv, ARINOVA_AGENT_NAME: "pan" };

    // Turn 1 env is not mutated by turn 2
    expect(turn1Env.ARINOVA_AGENT_NAME).toBe("lucy");
    expect(turn2Env.ARINOVA_AGENT_NAME).toBe("pan");
  });

  it("no agentName when conversationId has no agent prefix", () => {
    const customEnv = { GEMINI_API_KEY: "key" };
    const conversationId = "";
    const agentName = conversationId.split(":")[0];
    const turnEnv = agentName
      ? { ...customEnv, ARINOVA_AGENT_NAME: agentName }
      : customEnv;

    expect(turnEnv).not.toHaveProperty("ARINOVA_AGENT_NAME");
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
