import { describe, it, expect, vi } from "vitest";
import { processGeminiTurn, type GeminiEvent } from "../../../src/gemini/events.js";

async function* createEventStream(events: GeminiEvent[]): AsyncGenerator<GeminiEvent> {
  for (const event of events) {
    yield event;
  }
}

describe("gemini/events", () => {
  describe("processGeminiTurn", () => {
    const makeSink = () => ({
      onChunk: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    });

    it("extracts session ID from init event", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "init", session_id: "sess-123" },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.sessionId).toBe("sess-123");
    });

    it("streams assistant message deltas", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "message", role: "assistant", content: "Hello", delta: true },
        { type: "message", role: "assistant", content: " world", delta: true },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(sink.onChunk).toHaveBeenCalledTimes(2);
      expect(sink.onChunk).toHaveBeenNthCalledWith(1, "Hello");
      expect(sink.onChunk).toHaveBeenNthCalledWith(2, " world");
      expect(result.finalResponse).toBe("Hello world");
    });

    it("handles full message (non-delta) with partial overlap", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "message", role: "assistant", content: "He", delta: true },
        { type: "message", role: "assistant", content: "Hello world" },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(sink.onChunk).toHaveBeenCalledTimes(2);
      expect(sink.onChunk).toHaveBeenNthCalledWith(1, "He");
      expect(sink.onChunk).toHaveBeenNthCalledWith(2, "llo world");
      expect(result.finalResponse).toBe("Hello world");
    });

    it("ignores user messages", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "hello", delta: true },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(sink.onChunk).toHaveBeenCalledTimes(1);
      expect(result.finalResponse).toBe("hello");
    });

    it("extracts token usage from result stats", async () => {
      const sink = makeSink();
      const events = createEventStream([
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 100, output_tokens: 50, cached: 20 },
        },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
      });
    });

    it("defaults cached to 0 when not present", async () => {
      const sink = makeSink();
      const events = createEventStream([
        {
          type: "result",
          status: "success",
          stats: { input_tokens: 100, output_tokens: 50 },
        },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.usage?.cachedInputTokens).toBe(0);
    });

    it("calls onComplete with Done when no response", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "result", status: "success" },
      ]);

      await processGeminiTurn(events, sink);
      expect(sink.onComplete).toHaveBeenCalledWith("Done.");
    });

    it("handles error result", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "result", status: "error", error: { message: "rate limited" } },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.error).toBe("rate limited");
      expect(sink.onError).toHaveBeenCalledWith("rate limited");
    });

    it("handles error event with severity error", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "error", severity: "error", message: "fatal error" },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.error).toBe("fatal error");
      expect(sink.onError).toHaveBeenCalledWith("fatal error");
    });

    it("ignores error events with non-error severity", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "error", severity: "warning", message: "just a warning" },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.error).toBeNull();
      expect(sink.onError).not.toHaveBeenCalled();
    });

    it("skips tool_use and tool_result events", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "tool_use", tool_name: "bash", tool_id: "t1", parameters: {} },
        { type: "tool_result", tool_id: "t1", status: "success", output: "ok" },
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.sessionId).toBeNull();
      expect(result.finalResponse).toBe("");
    });

    it("returns null sessionId when no init event", async () => {
      const sink = makeSink();
      const events = createEventStream([
        { type: "result", status: "success" },
      ]);

      const result = await processGeminiTurn(events, sink);
      expect(result.sessionId).toBeNull();
    });
  });
});
