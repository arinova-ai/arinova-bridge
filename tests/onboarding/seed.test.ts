import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/util/logger.js";
import {
  hasSeedRun,
  markSeedRun,
  readOnboardingSeed,
  runOnboardingSeedTurn,
  type OnboardingSeed,
  type OnboardingSeedTurnDeps,
  type SeedCapableAgent,
} from "../../src/onboarding/seed.js";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeSeed(overrides: Partial<OnboardingSeed> = {}): OnboardingSeed {
  return {
    kind: "first_touch_opening",
    seedId: "onboarding:tok_123",
    agentId: "agent_abc",
    action: "create_onboarding_conversation_and_send_first_message",
    prompt: "Say hello and explain what you can do.",
    ...overrides,
  };
}

describe("readOnboardingSeed", () => {
  it("returns the seed when the agent exposes getOnboardingSeed", () => {
    const seed = makeSeed();
    const agent: SeedCapableAgent = { getOnboardingSeed: () => seed };
    expect(readOnboardingSeed(agent)).toBe(seed);
  });

  it("returns null when getOnboardingSeed yields null", () => {
    const agent: SeedCapableAgent = { getOnboardingSeed: () => null };
    expect(readOnboardingSeed(agent)).toBeNull();
  });

  it("returns null on an SDK that predates OB-11 (method absent)", () => {
    const agent: SeedCapableAgent = {};
    expect(readOnboardingSeed(agent)).toBeNull();
  });
});

describe("runOnboardingSeedTurn", () => {
  it("runs the strict ordering: dedup → create → turn → send → mark", async () => {
    const calls: string[] = [];
    const deps: OnboardingSeedTurnDeps = {
      logger: noopLogger,
      hasSeedRun: (id) => {
        calls.push(`hasSeedRun:${id}`);
        return false;
      },
      createConversation: async (agentId) => {
        calls.push(`createConversation:${agentId}`);
        return "conv_1";
      },
      runTurn: async (prompt) => {
        calls.push(`runTurn:${prompt}`);
        return "Hi! I'm your agent.";
      },
      sendMessage: async (conversationId, content) => {
        calls.push(`sendMessage:${conversationId}:${content}`);
      },
      markSeedRun: (id) => {
        calls.push(`markSeedRun:${id}`);
      },
    };

    await runOnboardingSeedTurn(makeSeed(), deps);

    expect(calls).toEqual([
      "hasSeedRun:onboarding:tok_123",
      "createConversation:agent_abc",
      "runTurn:Say hello and explain what you can do.",
      "sendMessage:conv_1:Hi! I'm your agent.",
      "markSeedRun:onboarding:tok_123",
    ]);
  });

  it("short-circuits when the seed was already consumed", async () => {
    const createConversation = vi.fn();
    const runTurn = vi.fn();
    const sendMessage = vi.fn();
    const markSeedRun = vi.fn();

    await runOnboardingSeedTurn(makeSeed(), {
      logger: noopLogger,
      hasSeedRun: () => true,
      createConversation,
      runTurn,
      sendMessage,
      markSeedRun,
    });

    expect(createConversation).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markSeedRun).not.toHaveBeenCalled();
  });

  it("does not mark the seed when the conversation cannot be created (retryable)", async () => {
    const runTurn = vi.fn();
    const sendMessage = vi.fn();
    const markSeedRun = vi.fn();

    await runOnboardingSeedTurn(makeSeed(), {
      logger: noopLogger,
      hasSeedRun: () => false,
      createConversation: async () => null,
      runTurn,
      sendMessage,
      markSeedRun,
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markSeedRun).not.toHaveBeenCalled();
  });

  it("does not send or mark when the turn produces empty output (retryable)", async () => {
    const sendMessage = vi.fn();
    const markSeedRun = vi.fn();

    await runOnboardingSeedTurn(makeSeed(), {
      logger: noopLogger,
      hasSeedRun: () => false,
      createConversation: async () => "conv_1",
      runTurn: async () => "   \n  ",
      sendMessage,
      markSeedRun,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markSeedRun).not.toHaveBeenCalled();
  });

  it("trims the greeting before sending", async () => {
    const sent: string[] = [];
    await runOnboardingSeedTurn(makeSeed(), {
      logger: noopLogger,
      hasSeedRun: () => false,
      createConversation: async () => "conv_1",
      runTurn: async () => "  Hello there  ",
      sendMessage: async (_id, content) => {
        sent.push(content);
      },
      markSeedRun: () => {},
    });

    expect(sent).toEqual(["Hello there"]);
  });

  it("does not mark the seed when delivery fails (retryable next boot)", async () => {
    const markSeedRun = vi.fn();

    await expect(
      runOnboardingSeedTurn(makeSeed(), {
        logger: noopLogger,
        hasSeedRun: () => false,
        createConversation: async () => "conv_1",
        runTurn: async () => "Hello",
        sendMessage: async () => {
          throw new Error("server down");
        },
        markSeedRun,
      }),
    ).rejects.toThrow("server down");

    expect(markSeedRun).not.toHaveBeenCalled();
  });
});

describe("seedId disk persistence (cross-restart dedup)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ob11-seed-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports an unseen seedId as not run", () => {
    expect(hasSeedRun("onboarding:tok_unseen", dir)).toBe(false);
  });

  it("persists a consumed seedId so a later read still sees it", () => {
    markSeedRun("onboarding:tok_123", noopLogger, dir);
    // Simulates a fresh process: a brand-new read from the same on-disk store.
    expect(hasSeedRun("onboarding:tok_123", dir)).toBe(true);
  });

  it("keeps distinct seedIds independent", () => {
    markSeedRun("onboarding:tok_a", noopLogger, dir);
    expect(hasSeedRun("onboarding:tok_a", dir)).toBe(true);
    expect(hasSeedRun("onboarding:tok_b", dir)).toBe(false);
  });

  it("is idempotent — marking the same seedId twice records it once", () => {
    markSeedRun("onboarding:tok_123", noopLogger, dir);
    markSeedRun("onboarding:tok_123", noopLogger, dir);
    markSeedRun("onboarding:tok_456", noopLogger, dir);
    expect(hasSeedRun("onboarding:tok_123", dir)).toBe(true);
    expect(hasSeedRun("onboarding:tok_456", dir)).toBe(true);
  });

  it("the orchestrator's default dedup hooks use the disk store end-to-end", async () => {
    const seed = makeSeed({ seedId: "onboarding:tok_e2e" });
    const sendMessage = vi.fn(async () => {});

    const deps = {
      logger: noopLogger,
      createConversation: async () => "conv_1",
      runTurn: async () => "Hello",
      sendMessage,
      // Bind the real disk store to the temp dir (defaults target $HOME).
      hasSeedRun: (id: string) => hasSeedRun(id, dir),
      markSeedRun: (id: string) => markSeedRun(id, noopLogger, dir),
    } satisfies OnboardingSeedTurnDeps;

    await runOnboardingSeedTurn(seed, deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(hasSeedRun("onboarding:tok_e2e", dir)).toBe(true);

    // A reconnect (second run) must not re-seed.
    await runOnboardingSeedTurn(seed, deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
