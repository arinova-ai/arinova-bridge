import { describe, it, expect, beforeEach } from "vitest";
import {
  BridgeDeliveryTracker,
  type BridgeDeliveryState,
  type CancelDeliveryResult,
} from "../../../src/ipc/deliveries.js";

/**
 * Tests for the Inspector Bridge IPC tracker that backs the `snapshot` and
 * `cancel-delivery` handlers consumed by rust-server (queue_inspector/bridge.rs).
 */

describe("BridgeDeliveryTracker.register", () => {
  let tracker: BridgeDeliveryTracker;

  beforeEach(() => {
    tracker = new BridgeDeliveryTracker();
  });

  it("returns a unique uuid delivery_id", () => {
    const a = tracker.register({
      sourceAgentId: "lucy",
      targetAgentId: "ron",
      payload: "hi",
      abortController: new AbortController(),
    });
    const b = tracker.register({
      sourceAgentId: "lucy",
      targetAgentId: "ron",
      payload: "hi",
      abortController: new AbortController(),
    });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("snapshots include dispatched_at as ISO8601 and acked_at as null", () => {
    const before = new Date().toISOString();
    tracker.register({
      sourceAgentId: "linda",
      targetAgentId: "hank",
      payload: "test",
      abortController: new AbortController(),
    });
    const after = new Date().toISOString();

    const [entry] = tracker.snapshot();
    expect(entry.acked_at).toBeNull();
    expect(entry.dispatched_at >= before).toBe(true);
    expect(entry.dispatched_at <= after).toBe(true);
    expect(entry.source_agent_id).toBe("linda");
    expect(entry.target_agent_id).toBe("hank");
  });

  it("payload_preview truncates exactly at 100 chars (no suffix)", () => {
    const longPayload = "x".repeat(250);
    tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: longPayload,
      abortController: new AbortController(),
    });
    const [entry] = tracker.snapshot();
    expect(entry.payload_preview.length).toBe(100);
    expect(entry.payload_preview).toBe("x".repeat(100));
  });

  it("payload shorter than 100 chars is preserved verbatim", () => {
    tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "short",
      abortController: new AbortController(),
    });
    expect(tracker.snapshot()[0].payload_preview).toBe("short");
  });

  it("payload_preview at exactly 100 chars is preserved", () => {
    const exact = "y".repeat(100);
    tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: exact,
      abortController: new AbortController(),
    });
    expect(tracker.snapshot()[0].payload_preview).toBe(exact);
  });
});

describe("BridgeDeliveryTracker.markAcked", () => {
  let tracker: BridgeDeliveryTracker;

  beforeEach(() => {
    tracker = new BridgeDeliveryTracker();
  });

  it("sets acked_at to ISO timestamp on first call", () => {
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: new AbortController(),
    });
    tracker.markAcked(id);
    const [entry] = tracker.snapshot();
    expect(entry.acked_at).not.toBeNull();
    expect(entry.acked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is idempotent — second markAcked does not overwrite first timestamp", async () => {
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: new AbortController(),
    });
    tracker.markAcked(id);
    const first = tracker.snapshot()[0].acked_at;
    await new Promise((r) => setTimeout(r, 5));
    tracker.markAcked(id);
    expect(tracker.snapshot()[0].acked_at).toBe(first);
  });

  it("ignores unknown delivery_id silently", () => {
    expect(() => tracker.markAcked("not-a-real-id")).not.toThrow();
  });
});

describe("BridgeDeliveryTracker.snapshot", () => {
  let tracker: BridgeDeliveryTracker;

  beforeEach(() => {
    tracker = new BridgeDeliveryTracker();
  });

  it("returns empty array when no deliveries", () => {
    expect(tracker.snapshot()).toEqual([]);
  });

  it("returns all active deliveries", () => {
    for (let i = 0; i < 3; i++) {
      tracker.register({
        sourceAgentId: `src-${i}`,
        targetAgentId: `dst-${i}`,
        payload: `p-${i}`,
        abortController: new AbortController(),
      });
    }
    const items = tracker.snapshot();
    expect(items).toHaveLength(3);
    const sources = items.map((d) => d.source_agent_id).sort();
    expect(sources).toEqual(["src-0", "src-1", "src-2"]);
  });

  it("returns shallow copies — mutating result does not affect tracker state", () => {
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: new AbortController(),
    });
    const items = tracker.snapshot();
    items[0].acked_at = "fake-timestamp";

    // Internal state unchanged
    expect(tracker.snapshot()[0].acked_at).toBeNull();
    tracker.markAcked(id);
    expect(tracker.snapshot()[0].acked_at).not.toBe("fake-timestamp");
  });
});

describe("BridgeDeliveryTracker.complete", () => {
  let tracker: BridgeDeliveryTracker;

  beforeEach(() => {
    tracker = new BridgeDeliveryTracker();
  });

  it("removes the delivery from the snapshot", () => {
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: new AbortController(),
    });
    expect(tracker.snapshot()).toHaveLength(1);
    tracker.complete(id);
    expect(tracker.snapshot()).toHaveLength(0);
  });

  it("is a no-op for unknown delivery_id", () => {
    expect(() => tracker.complete("nope")).not.toThrow();
  });
});

describe("BridgeDeliveryTracker.cancel — race classification", () => {
  let tracker: BridgeDeliveryTracker;

  beforeEach(() => {
    tracker = new BridgeDeliveryTracker();
  });

  it("returns 'not_found' for unknown delivery_id", () => {
    const result: CancelDeliveryResult = tracker.cancel("does-not-exist");
    expect(result).toBe("not_found");
  });

  it("returns 'success' when delivery is unacked, fires abort, removes entry", () => {
    const controller = new AbortController();
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: controller,
    });

    expect(controller.signal.aborted).toBe(false);
    expect(tracker.cancel(id)).toBe("success");
    expect(controller.signal.aborted).toBe(true);
    expect(tracker.snapshot()).toHaveLength(0);
  });

  it("returns 'partial' when delivery was already acked — race condition", () => {
    const controller = new AbortController();
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: controller,
    });

    tracker.markAcked(id);
    expect(tracker.cancel(id)).toBe("partial");
    expect(controller.signal.aborted).toBe(true);
    // Still removed after cancel, partial or success
    expect(tracker.snapshot()).toHaveLength(0);
  });

  it("second cancel of the same id returns 'not_found'", () => {
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: new AbortController(),
    });
    expect(tracker.cancel(id)).toBe("success");
    expect(tracker.cancel(id)).toBe("not_found");
  });

  it("cancel after natural completion returns 'not_found'", () => {
    const id = tracker.register({
      sourceAgentId: "a",
      targetAgentId: "b",
      payload: "p",
      abortController: new AbortController(),
    });
    tracker.markAcked(id);
    tracker.complete(id);
    expect(tracker.cancel(id)).toBe("not_found");
  });
});

describe("BridgeDeliveryState wire shape", () => {
  it("has all the snake_case fields rust-server expects", () => {
    const tracker = new BridgeDeliveryTracker();
    tracker.register({
      sourceAgentId: "lucy",
      targetAgentId: "ron",
      payload: "deliver this",
      abortController: new AbortController(),
    });
    const entry: BridgeDeliveryState = tracker.snapshot()[0];
    expect(Object.keys(entry).sort()).toEqual([
      "acked_at",
      "delivery_id",
      "dispatched_at",
      "payload_preview",
      "source_agent_id",
      "target_agent_id",
    ]);
  });
});
