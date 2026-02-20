import { describe, it, expect, vi } from "vitest";
import { ConversationQueue } from "../../../src/codex/queue.js";

describe("ConversationQueue", () => {
  it("executes a single task", async () => {
    const queue = new ConversationQueue();
    const fn = vi.fn(async () => {});

    await queue.enqueue("conv-1", fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("serializes tasks for the same conversation", async () => {
    const queue = new ConversationQueue();
    const order: number[] = [];

    const task1 = queue.enqueue("conv-1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
    });

    const task2 = queue.enqueue("conv-1", async () => {
      order.push(3);
    });

    await Promise.all([task1, task2]);

    // Task 2 should not start until task 1 finishes
    expect(order).toEqual([1, 2, 3]);
  });

  it("allows parallel execution for different conversations", async () => {
    const queue = new ConversationQueue();
    const order: string[] = [];

    const task1 = queue.enqueue("conv-1", async () => {
      order.push("1-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("1-end");
    });

    const task2 = queue.enqueue("conv-2", async () => {
      order.push("2-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("2-end");
    });

    await Promise.all([task1, task2]);

    // Both should start before either ends (parallel)
    expect(order.indexOf("2-start")).toBeLessThan(order.indexOf("1-end"));
  });

  it("tracks active processes", () => {
    const queue = new ConversationQueue();
    expect(queue.activeProcesses.size).toBe(0);

    // activeProcesses is a public Map
    queue.activeProcesses.set("conv-1", {} as any);
    expect(queue.activeProcesses.has("conv-1")).toBe(true);

    queue.activeProcesses.delete("conv-1");
    expect(queue.activeProcesses.has("conv-1")).toBe(false);
  });

  it("propagates task errors", async () => {
    const queue = new ConversationQueue();

    await expect(
      queue.enqueue("conv-1", async () => {
        throw new Error("Task failed");
      }),
    ).rejects.toThrow("Task failed");
  });

  it("continues processing after a failed task", async () => {
    const queue = new ConversationQueue();
    const fn = vi.fn(async () => {});

    // First task fails
    const p1 = queue.enqueue("conv-1", async () => {
      throw new Error("fail");
    }).catch(() => {});

    // Second task should still run
    const p2 = queue.enqueue("conv-1", fn);

    await Promise.all([p1, p2]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
