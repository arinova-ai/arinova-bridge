import { describe, it, expect, vi } from "vitest";
import { processTurn, type ThreadEvent } from "../../../src/codex/events.js";

/** Helper to create an async generator from an array of events. */
async function* eventStream(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
}

function createSink() {
  return {
    chunks: [] as string[],
    completed: null as string | null,
    error: null as string | null,
    onChunk: vi.fn((text: string) => {
      // Track chunks
    }),
    onComplete: vi.fn((content: string) => {}),
    onError: vi.fn((error: string) => {}),
  };
}

describe("processTurn", () => {
  it("extracts thread_id from thread.started event", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-123" },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const result = await processTurn(eventStream(events), sink);

    expect(result.threadId).toBe("thread-123");
    expect(result.usage).toEqual({
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
    });
  });

  it("streams agent_message text as deltas", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      {
        type: "item.started",
        item: { id: "msg-1", type: "agent_message", text: "Hello" },
      },
      {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: "Hello world" },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Hello world!" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const result = await processTurn(eventStream(events), sink);

    // Should send deltas, not full text
    expect(sink.onChunk).toHaveBeenCalledTimes(3);
    expect(sink.onChunk.mock.calls[0][0]).toBe("Hello");
    expect(sink.onChunk.mock.calls[1][0]).toBe(" world");
    expect(sink.onChunk.mock.calls[2][0]).toBe("!");

    expect(result.finalResponse).toBe("Hello world!");
  });

  it("skips non-agent_message items", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "file.ts",
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Done" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const result = await processTurn(eventStream(events), sink);

    expect(result.finalResponse).toBe("Done");
    // Only the agent_message should trigger onChunk
    expect(sink.onChunk).toHaveBeenCalledTimes(1);
    expect(sink.onChunk).toHaveBeenCalledWith("Done");
  });

  it("calls onComplete on turn.completed", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Result" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    await processTurn(eventStream(events), sink);
    expect(sink.onComplete).toHaveBeenCalledWith("Result");
  });

  it("calls onError on turn.failed", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      { type: "turn.failed", error: { message: "Out of tokens" } },
    ];

    await processTurn(eventStream(events), sink);
    expect(sink.onError).toHaveBeenCalledWith("Out of tokens");
  });

  it("calls onError on error event", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      { type: "error", message: "Connection lost" },
    ];

    await processTurn(eventStream(events), sink);
    expect(sink.onError).toHaveBeenCalledWith("Connection lost");
  });

  it("returns null threadId when no thread.started event", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      {
        type: "turn.completed",
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      },
    ];

    const result = await processTurn(eventStream(events), sink);
    expect(result.threadId).toBeNull();
  });

  it("defaults to 'Done.' when no final response", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    await processTurn(eventStream(events), sink);
    expect(sink.onComplete).toHaveBeenCalledWith("Done.");
  });

  it("handles multiple agent_message items (resets delta tracking)", async () => {
    const sink = createSink();
    const events: ThreadEvent[] = [
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "First" },
      },
      {
        type: "item.started",
        item: { id: "msg-2", type: "agent_message", text: "Second" },
      },
      {
        type: "item.completed",
        item: { id: "msg-2", type: "agent_message", text: "Second message" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const result = await processTurn(eventStream(events), sink);

    // After item.completed for msg-1, lastSentLength resets to 0
    // So msg-2 starts fresh
    expect(sink.onChunk).toHaveBeenCalledWith("First");
    expect(sink.onChunk).toHaveBeenCalledWith("Second");
    expect(sink.onChunk).toHaveBeenCalledWith(" message");
    expect(result.finalResponse).toBe("Second message");
  });
});
