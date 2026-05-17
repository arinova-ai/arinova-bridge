import { describe, it, expect } from "vitest";
import { runExclusiveOnAgent, BridgeTaskTimeoutError } from "../../../src/ipc/router.js";

/**
 * Tests for runExclusiveOnAgent hard-timeout guard.
 *
 * Root cause covered: a stuck task (Anthropic API hang, pty stuck, network
 * stall) used to pin the per-agent promise chain forever while bridge WS
 * heartbeats reset the chat-backend 600s idle timer — only path to recovery
 * was a manual bridge restart. With the timeout guard, the chain releases
 * after `timeoutMs` and the optional AbortController is fired so the inner
 * SDK call can terminate the socket recv.
 */
describe("runExclusiveOnAgent — hard timeout", () => {
  it("force-resolves the chain when fn exceeds timeoutMs", async () => {
    const started = Date.now();
    await expect(
      runExclusiveOnAgent(
        "timeout-agent-1",
        () => new Promise(() => { /* never resolves */ }),
        { timeoutMs: 100 },
      ),
    ).rejects.toBeInstanceOf(BridgeTaskTimeoutError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("releases the chain on timeout so the next task on the same agent can run", async () => {
    const stuck = runExclusiveOnAgent(
      "timeout-agent-2",
      () => new Promise(() => { /* never resolves */ }),
      { timeoutMs: 50 },
    );
    const next = runExclusiveOnAgent(
      "timeout-agent-2",
      async () => "next-ok",
      { timeoutMs: 1000 },
    );
    await expect(stuck).rejects.toBeInstanceOf(BridgeTaskTimeoutError);
    await expect(next).resolves.toBe("next-ok");
  });

  it("aborts the provided AbortController on timeout so the inner SDK can exit", async () => {
    const ctrl = new AbortController();
    expect(ctrl.signal.aborted).toBe(false);
    await expect(
      runExclusiveOnAgent(
        "timeout-agent-3",
        () => new Promise(() => { /* never resolves */ }),
        { timeoutMs: 50, abortController: ctrl },
      ),
    ).rejects.toBeInstanceOf(BridgeTaskTimeoutError);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("does not abort the controller if fn completes before timeout", async () => {
    const ctrl = new AbortController();
    const result = await runExclusiveOnAgent(
      "timeout-agent-4",
      async () => 42,
      { timeoutMs: 1000, abortController: ctrl },
    );
    expect(result).toBe(42);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("propagates fn rejection without firing the timeout when fn fails fast", async () => {
    const ctrl = new AbortController();
    await expect(
      runExclusiveOnAgent(
        "timeout-agent-5",
        async () => { throw new Error("fn-failed"); },
        { timeoutMs: 1000, abortController: ctrl },
      ),
    ).rejects.toThrow("fn-failed");
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("serializes tasks on the same agent (chain ordering preserved)", async () => {
    const order: string[] = [];
    const t1 = runExclusiveOnAgent("timeout-agent-6", async () => {
      order.push("t1-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("t1-end");
    }, { timeoutMs: 1000 });
    const t2 = runExclusiveOnAgent("timeout-agent-6", async () => {
      order.push("t2-start");
      order.push("t2-end");
    }, { timeoutMs: 1000 });
    await Promise.all([t1, t2]);
    expect(order).toEqual(["t1-start", "t1-end", "t2-start", "t2-end"]);
  });

  it("BridgeTaskTimeoutError exposes agentName and timeoutMs for caller diagnostics", async () => {
    let captured: BridgeTaskTimeoutError | undefined;
    try {
      await runExclusiveOnAgent(
        "diag-agent",
        () => new Promise(() => {}),
        { timeoutMs: 25 },
      );
    } catch (err) {
      if (err instanceof BridgeTaskTimeoutError) captured = err;
    }
    expect(captured).toBeInstanceOf(BridgeTaskTimeoutError);
    expect(captured?.agentName).toBe("diag-agent");
    expect(captured?.timeoutMs).toBe(25);
    expect(captured?.message).toContain("BRIDGE_TASK_TIMEOUT_MS");
  });
});
