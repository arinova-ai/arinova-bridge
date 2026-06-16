import { describe, it, expect, vi } from "vitest";
import { rejectTaskWithoutConversation } from "../../src/agent-task-guard.js";

describe("rejectTaskWithoutConversation", () => {
  it("sends a terminal error so the SDK releases the task lock (not a bare return)", () => {
    const sendError = vi.fn();
    const error = vi.fn();

    rejectTaskWithoutConversation({ sendError }, "Hank", { error });

    // The whole point of the guard: it must call sendError (which the SDK turns
    // into markFinished -> stop heartbeat / delete task / release agent-wide
    // lock). A bare return would leak the task and deadlock the agent.
    expect(sendError).toHaveBeenCalledTimes(1);
    expect(sendError).toHaveBeenCalledWith(expect.stringContaining("conversationId"));
  });

  it("logs the rejection with the agent name", () => {
    const error = vi.fn();

    rejectTaskWithoutConversation({ sendError: vi.fn() }, "Casey", { error });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Casey"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("conversationId"));
  });
});
