/**
 * A single tool call report, emitted immediately after each tool completes.
 * Mirrors `@arinova-ai/agent-sdk`'s `ToolCallReport` so ClaudeProcess does
 * not need to depend on the SDK directly; the caller wires the reporter to
 * `ArinovaAgent.reportToolCall()`.
 */
export interface ToolCallReport {
  sessionId: string;
  turnId: string;
  seqOrder: number;
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  success: boolean;
  error?: string;
  /** UUID of the user message that triggered this turn (optional). */
  messageId?: string;
}

export interface PendingToolCall {
  toolName: string;
  input: Record<string, unknown>;
  startedAt: number;
  seqOrder: number;
}

export interface CapturedToolUses {
  pending: Array<[id: string, call: PendingToolCall]>;
  nextSeqOrder: number;
}

export interface CapturedToolResults {
  reports: ToolCallReport[];
  completedIds: string[];
}

/**
 * Flatten a tool_result `content` value into a string for error reporting.
 * Claude emits either a plain string or an array of `{type:"text",text}` blocks.
 */
export function toolResultContentToString(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
        }
        return typeof block === "string" ? block : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function captureToolUsesFromEvent(
  event: Record<string, unknown>,
  seqOrder: number,
  now = Date.now(),
): CapturedToolUses {
  const message = event.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  const pending: Array<[id: string, call: PendingToolCall]> = [];
  let nextSeqOrder = seqOrder;

  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== "tool_use") continue;
    const id = typeof block.id === "string" ? block.id : "";
    if (!id) continue;
    const toolName = typeof block.name === "string" ? block.name : "";
    const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
    pending.push([
      id,
      {
        toolName,
        input,
        startedAt: now,
        seqOrder: nextSeqOrder++,
      },
    ]);
  }

  return { pending, nextSeqOrder };
}

export function captureToolResultsFromEvent(opts: {
  event: Record<string, unknown>;
  pendingToolCalls: ReadonlyMap<string, PendingToolCall>;
  sessionId: string;
  turnId: string;
  messageId?: string;
  now?: number;
}): CapturedToolResults {
  const message = opts.event.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  const reports: ToolCallReport[] = [];
  const completedIds: string[] = [];
  const now = opts.now ?? Date.now();

  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const useId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    if (!useId) continue;
    const pending = opts.pendingToolCalls.get(useId);
    if (!pending) continue;

    const isError = block.is_error === true;
    const rawOutput = (block as { content?: unknown }).content;
    const report: ToolCallReport = {
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      seqOrder: pending.seqOrder,
      toolName: pending.toolName,
      input: pending.input,
      durationMs: now - pending.startedAt,
      success: !isError,
    };
    if (opts.messageId) report.messageId = opts.messageId;
    if (isError) {
      report.error = toolResultContentToString(rawOutput);
    } else if (rawOutput !== undefined) {
      report.output = rawOutput;
    }

    reports.push(report);
    completedIds.push(useId);
  }

  return { reports, completedIds };
}
