import { describe, expect, it } from "vitest";
import {
  captureToolResultsFromEvent,
  captureToolUsesFromEvent,
  toolResultContentToString,
  type PendingToolCall,
} from "../../../src/claude/tool-call-reporting.js";

describe("tool-call reporting helpers", () => {
  it("captures ordered tool_use blocks and ignores missing ids", () => {
    const captured = captureToolUsesFromEvent(
      {
        message: {
          content: [
            { type: "text", text: "ignore" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file: "a.ts" } },
            { type: "tool_use", name: "NoId", input: { bad: true } },
            { type: "tool_use", id: "tool-2", name: "Write", input: "not-object" },
          ],
        },
      },
      5,
      1000,
    );

    expect(captured.nextSeqOrder).toBe(7);
    expect(captured.pending).toEqual([
      ["tool-1", { toolName: "Read", input: { file: "a.ts" }, startedAt: 1000, seqOrder: 5 }],
      ["tool-2", { toolName: "Write", input: {}, startedAt: 1000, seqOrder: 6 }],
    ]);
  });

  it("captures successful tool_result reports and leaves unknown results ignored", () => {
    const pending = new Map<string, PendingToolCall>([
      ["tool-1", { toolName: "Read", input: { file: "a.ts" }, startedAt: 1000, seqOrder: 0 }],
    ]);

    const captured = captureToolResultsFromEvent({
      event: {
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "ok" }] },
            { type: "tool_result", tool_use_id: "unknown", content: "ignored" },
            { type: "tool_result", content: "missing id" },
          ],
        },
      },
      pendingToolCalls: pending,
      sessionId: "sess",
      turnId: "turn",
      messageId: "msg",
      now: 1250,
    });

    expect(captured.completedIds).toEqual(["tool-1"]);
    expect(captured.reports).toEqual([
      {
        sessionId: "sess",
        turnId: "turn",
        messageId: "msg",
        seqOrder: 0,
        toolName: "Read",
        input: { file: "a.ts" },
        output: [{ type: "text", text: "ok" }],
        durationMs: 250,
        success: true,
      },
    ]);
  });

  it("captures error tool_result reports with flattened error text", () => {
    const pending = new Map<string, PendingToolCall>([
      ["tool-1", { toolName: "Bash", input: { command: "false" }, startedAt: 1000, seqOrder: 1 }],
    ]);

    const captured = captureToolResultsFromEvent({
      event: {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: true,
              content: [{ type: "text", text: "line 1" }, "line 2", { type: "image", data: "ignored" }],
            },
          ],
        },
      },
      pendingToolCalls: pending,
      sessionId: "sess",
      turnId: "turn",
      now: 1300,
    });

    expect(captured.reports[0]).toMatchObject({
      sessionId: "sess",
      turnId: "turn",
      seqOrder: 1,
      toolName: "Bash",
      input: { command: "false" },
      durationMs: 300,
      success: false,
      error: "line 1\nline 2",
    });
  });

  it("flattens string, array, object, null, and circular error content", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(toolResultContentToString("plain")).toBe("plain");
    expect(toolResultContentToString([{ text: "a" }, "b", { nope: true }])).toBe("a\nb");
    expect(toolResultContentToString({ ok: true })).toBe('{"ok":true}');
    expect(toolResultContentToString(null)).toBe("");
    expect(toolResultContentToString(circular)).toBe("[object Object]");
  });
});
