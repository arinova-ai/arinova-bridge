import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BridgeSessionStore } from "../../../src/session/bridge-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Integration tests: BridgeSessionStore.compact() — PROTECT_LAST_N = 10
// ---------------------------------------------------------------------------

const PROTECT_FIRST_N = 2;
const PROTECT_LAST_N = 10;

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

describe("BridgeSessionStore.compact()", () => {
  let store: BridgeSessionStore;
  let tmpDir: string;
  const convId = "test-conv-1";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bridge-test-"));
    store = new BridgeSessionStore(tmpDir, createLogger() as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function addMessages(n: number) {
    for (let i = 1; i <= n; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `user msg ${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `assistant msg ${i}`, "bot");
      }
    }
  }

  it("protects first 2 and last 10 messages, compresses only the middle", async () => {
    // Add 20 messages: first 2 protected, last 10 protected, middle 8 compacted
    addMessages(20);
    const before = store.getMessages(convId);
    expect(before).toHaveLength(20);

    let middleMessages: any[] = [];
    await store.compact(convId, async (messages, _existing) => {
      middleMessages = messages;
      return "compacted summary text";
    });

    // Middle should be messages 3-10 (indices 2-9), which is 8 messages
    expect(middleMessages).toHaveLength(8);
    expect(middleMessages[0].content).toBe("user msg 3");
    expect(middleMessages[middleMessages.length - 1].content).toBe("assistant msg 10");

    // After compact: first 2 + last 10 = 12 remaining
    const after = store.getMessages(convId);
    expect(after).toHaveLength(12);

    // Verify first 2 preserved
    expect(after[0].content).toBe("user msg 1");
    expect(after[1].content).toBe("assistant msg 2");

    // Verify last 10 preserved (messages 11-20)
    expect(after[2].content).toBe("user msg 11");
    expect(after[11].content).toBe("assistant msg 20");
  });

  it("does nothing when total messages <= PROTECT_FIRST_N + PROTECT_LAST_N", async () => {
    // 12 messages = exactly the threshold (2 + 10)
    addMessages(12);
    const summariser = async () => "should not be called";

    await store.compact(convId, summariser);

    // All 12 messages should remain
    const after = store.getMessages(convId);
    expect(after).toHaveLength(12);
  });

  it("does nothing when fewer than threshold messages", async () => {
    addMessages(5);
    const summariser = async () => "should not be called";

    await store.compact(convId, summariser);

    const after = store.getMessages(convId);
    expect(after).toHaveLength(5);
  });

  it("compresses just 1 middle message when total = 13", async () => {
    addMessages(13);

    let middleCount = 0;
    await store.compact(convId, async (messages) => {
      middleCount = messages.length;
      return "summary";
    });

    // 13 - 2 - 10 = 1 middle message
    expect(middleCount).toBe(1);

    const after = store.getMessages(convId);
    expect(after).toHaveLength(12); // 2 + 10 preserved
  });

  it("passes existing compacted_summary to summariser for incremental compaction", async () => {
    addMessages(20);

    // First compact
    await store.compact(convId, async (_messages, existing) => {
      expect(existing).toBeUndefined();
      return "first summary";
    });

    // Add more messages to trigger second compact
    for (let i = 21; i <= 35; i++) {
      if (i % 2 === 1) {
        store.addUserMessage(convId, `user msg ${i}`, "user");
      } else {
        store.addAssistantMessage(convId, `assistant msg ${i}`, "bot");
      }
    }

    // Second compact — should receive "first summary" as existing
    let receivedExisting: string | undefined;
    await store.compact(convId, async (_messages, existing) => {
      receivedExisting = existing;
      return "merged summary";
    });

    expect(receivedExisting).toBe("first summary");
  });

  it("does not modify DB when summariser throws", async () => {
    addMessages(20);
    const before = store.getMessages(convId);

    await expect(
      store.compact(convId, async () => {
        throw new Error("summariser failed");
      }),
    ).rejects.toThrow("summariser failed");

    // Messages unchanged
    const after = store.getMessages(convId);
    expect(after).toHaveLength(before.length);
    expect(after.map((m) => m.content)).toEqual(before.map((m) => m.content));
  });

  it("compact succeeds then allows normal retry", async () => {
    addMessages(20);

    await store.compact(convId, async () => "first compact");
    const afterFirst = store.getMessages(convId);
    expect(afterFirst).toHaveLength(12);

    // Add enough messages to make middle non-empty again
    for (let i = 0; i < 15; i++) {
      store.addUserMessage(convId, `extra msg ${i}`, "user");
    }

    // 12 + 15 = 27 → middle = 27 - 2 - 10 = 15
    await store.compact(convId, async () => "second compact");
    const afterSecond = store.getMessages(convId);
    expect(afterSecond).toHaveLength(12);
  });
});
