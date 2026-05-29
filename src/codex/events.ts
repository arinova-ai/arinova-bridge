export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export type ThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.completed"; usage?: TokenUsage }
  | { type: "turn.failed"; error?: { message?: string } | string }
  | { type: "error"; message?: string }
  | {
      type: "item.started" | "item.updated" | "item.completed";
      item?: {
        id?: string;
        type?: string;
        text?: string;
        [key: string]: unknown;
      };
    }
  | { type: string; [key: string]: unknown };

export interface TurnSink {
  onChunk?: (text: string) => void;
  onComplete?: (content: string) => void;
  onError?: (error: string) => void;
}

export interface ProcessTurnResult {
  threadId: string | null;
  finalResponse: string;
  usage: TokenUsage | null;
}

export async function processTurn(events: AsyncIterable<ThreadEvent>, sink: TurnSink): Promise<ProcessTurnResult> {
  let threadId: string | null = null;
  let usage: TokenUsage | null = null;
  let finalResponse = "";
  const sentLengths = new Map<string, number>();

  for await (const rawEvent of events) {
    const event = rawEvent as Record<string, unknown>;
    if (event.type === "thread.started") {
      threadId = typeof event.thread_id === "string" ? event.thread_id : null;
      continue;
    }

    if (event.type === "turn.failed") {
      sink.onError?.(errorMessage(event.error, "Turn failed"));
      continue;
    }

    if (event.type === "error") {
      sink.onError?.(typeof event.message === "string" ? event.message : "Unknown error");
      continue;
    }

    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : null;
      if (item?.type !== "agent_message") continue;

      const id = typeof item.id === "string" ? item.id : "__default_agent_message__";
      const text = typeof item.text === "string" ? item.text : "";
      const previousLength = sentLengths.get(id) ?? 0;
      const delta = text.slice(previousLength);
      if (delta) {
        sink.onChunk?.(delta);
        sentLengths.set(id, text.length);
      }
      finalResponse = text;
      continue;
    }

    if (event.type === "turn.completed") {
      usage = normalizeUsage(event.usage);
      const content = finalResponse || "Done.";
      sink.onComplete?.(content);
      if (!finalResponse) finalResponse = content;
    }
  }

  return { threadId, finalResponse, usage };
}

function normalizeUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    cached_input_tokens: typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : 0,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
