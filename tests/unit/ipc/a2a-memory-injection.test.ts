import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";

/**
 * Tests for A2A 長期記憶注入 feature:
 * 1. querySenderMemories() logic (source filtering, query truncation, formatting, error handling)
 * 2. deliverToAgent() integration — memory injection into bridgeSessionContext
 */

// --- querySenderMemories logic (replicated from router.ts since it's not exported) ---

const execFileAsync = vi.fn();

async function querySenderMemories(source: string, content: string): Promise<string | undefined> {
  if (!source || source === "cli" || source.includes(":")) return undefined;

  try {
    const queryText = content.length > 200 ? content.slice(0, 200) : content;
    const { stdout } = await execFileAsync("arinova", [
      "--profile", source,
      "--json",
      "memory", "query",
      "--query", queryText,
      "--limit", "10",
    ], { timeout: 10_000 });

    const memories = JSON.parse(stdout);
    if (!Array.isArray(memories) || memories.length === 0) return undefined;

    const lines = memories.map((m: { content?: string; title?: string }) =>
      m.title ? `- ${m.title}: ${m.content ?? ""}` : `- ${m.content ?? ""}`
    );
    return `[Sender memories — from ${source}]\n${lines.join("\n")}`;
  } catch {
    return undefined;
  }
}

describe("querySenderMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined for source = 'cli'", async () => {
    const result = await querySenderMemories("cli", "hello");
    expect(result).toBeUndefined();
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it("returns undefined for empty source", async () => {
    const result = await querySenderMemories("", "hello");
    expect(result).toBeUndefined();
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it("returns undefined for source containing ':' (spawn/fork)", async () => {
    for (const source of ["spawn:abc", "fork:123"]) {
      const result = await querySenderMemories(source, "hello");
      expect(result).toBeUndefined();
    }
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it("queries arinova CLI with correct profile and returns formatted memories", async () => {
    execFileAsync.mockResolvedValue({
      stdout: JSON.stringify([
        { title: "Preference", content: "User likes dark mode" },
        { content: "Always use TypeScript" },
      ]),
    });

    const result = await querySenderMemories("lucy", "What's the status?");

    expect(execFileAsync).toHaveBeenCalledWith(
      "arinova",
      ["--profile", "lucy", "--json", "memory", "query", "--query", "What's the status?", "--limit", "10"],
      { timeout: 10_000 },
    );
    expect(result).toBe(
      "[Sender memories — from lucy]\n- Preference: User likes dark mode\n- Always use TypeScript",
    );
  });

  it("truncates query text to 200 chars", async () => {
    const longContent = "A".repeat(300);
    execFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ content: "memory1" }]),
    });

    await querySenderMemories("pan", longContent);

    const call = execFileAsync.mock.calls[0];
    const queryArg = call[1][call[1].indexOf("--query") + 1];
    expect(queryArg.length).toBe(200);
  });

  it("returns undefined when memories array is empty", async () => {
    execFileAsync.mockResolvedValue({ stdout: "[]" });

    const result = await querySenderMemories("lucy", "hello");
    expect(result).toBeUndefined();
  });

  it("returns undefined when stdout is not valid JSON", async () => {
    execFileAsync.mockResolvedValue({ stdout: "not json" });

    const result = await querySenderMemories("lucy", "hello");
    expect(result).toBeUndefined();
  });

  it("returns undefined when execFileAsync rejects (timeout / process error)", async () => {
    execFileAsync.mockRejectedValue(new Error("timeout"));

    const result = await querySenderMemories("lucy", "hello");
    expect(result).toBeUndefined();
  });

  it("handles memory entries with title only (no content)", async () => {
    execFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ title: "Important note" }]),
    });

    const result = await querySenderMemories("bella", "query");
    expect(result).toBe("[Sender memories — from bella]\n- Important note: ");
  });

  it("handles memory entries with content only (no title)", async () => {
    execFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ content: "Remember to check tests" }]),
    });

    const result = await querySenderMemories("adele", "query");
    expect(result).toBe("[Sender memories — from adele]\n- Remember to check tests");
  });
});

// --- deliverToAgent integration: sender memory injection into context ---

describe("A2A deliver sender memory injection (integration)", () => {
  // Simulate the isFirstA2a + memory injection logic from deliverToAgent
  const a2aContextInjected = new Set<string>();

  function simulateDeliverContextBuild(
    syntheticId: string,
    from: string,
    content: string,
    buildContextResult: string | undefined,
    senderMemoriesResult: string | undefined,
  ): string | undefined {
    const isFirstA2a = !a2aContextInjected.has(syntheticId);
    let bridgeSessionContext = isFirstA2a ? buildContextResult : undefined;

    if (isFirstA2a && from !== "cli") {
      if (senderMemoriesResult) {
        bridgeSessionContext = bridgeSessionContext
          ? `${senderMemoriesResult}\n\n${bridgeSessionContext}`
          : senderMemoriesResult;
      }
    }

    if (isFirstA2a) a2aContextInjected.add(syntheticId);
    return bridgeSessionContext;
  }

  beforeEach(() => {
    a2aContextInjected.clear();
  });

  it("first A2A message from agent: injects sender memories + bridge context", () => {
    const ctx = simulateDeliverContextBuild(
      "pan:default", "lucy", "Please review this PR",
      "[Previous conversation]",
      "[Sender memories — from lucy]\n- Lucy prefers concise reviews",
    );

    expect(ctx).toBe(
      "[Sender memories — from lucy]\n- Lucy prefers concise reviews\n\n[Previous conversation]",
    );
  });

  it("second A2A message: skips memory injection (not isFirstA2a)", () => {
    // First message
    simulateDeliverContextBuild("pan:default", "lucy", "msg1", "[ctx]", "[memories]");

    // Second message
    const ctx = simulateDeliverContextBuild(
      "pan:default", "lucy", "msg2",
      "[ctx]",
      "[memories]",
    );

    expect(ctx).toBeUndefined();
  });

  it("source = 'cli': no memory injection even on first message", () => {
    const ctx = simulateDeliverContextBuild(
      "pan:default", "cli", "hello",
      "[Previous conversation]",
      undefined, // querySenderMemories returns undefined for cli
    );

    // Should still have bridge context but no memories prepended
    expect(ctx).toBe("[Previous conversation]");
  });

  it("first A2A with memories but no bridge context: memories only", () => {
    const ctx = simulateDeliverContextBuild(
      "pan:default", "lucy", "hello",
      undefined, // no bridge context (empty session store)
      "[Sender memories — from lucy]\n- Some memory",
    );

    expect(ctx).toBe("[Sender memories — from lucy]\n- Some memory");
  });

  it("first A2A with no memories and no bridge context: undefined", () => {
    const ctx = simulateDeliverContextBuild(
      "pan:default", "lucy", "hello",
      undefined,
      undefined,
    );

    expect(ctx).toBeUndefined();
  });

  it("after a2aContextInjected.delete (respawn/compact), re-injects memories", () => {
    // First inject
    simulateDeliverContextBuild("pan:default", "lucy", "msg1", "[ctx]", "[memories]");

    // Simulate respawn clearing the flag
    a2aContextInjected.delete("pan:default");

    // Should re-inject
    const ctx = simulateDeliverContextBuild(
      "pan:default", "lucy", "msg2",
      "[new ctx]",
      "[new memories]",
    );

    expect(ctx).toBe("[new memories]\n\n[new ctx]");
  });
});
