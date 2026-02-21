// Gemini CLI stream-json event types

export interface GeminiInitEvent {
  type: "init";
  session_id: string;
  model?: string;
}

export interface GeminiMessageEvent {
  type: "message";
  role: "user" | "assistant";
  content: string;
  delta?: boolean;
}

export interface GeminiToolUseEvent {
  type: "tool_use";
  tool_name: string;
  tool_id: string;
  parameters: unknown;
}

export interface GeminiToolResultEvent {
  type: "tool_result";
  tool_id: string;
  status: string;
  output?: string;
  error?: string;
}

export interface GeminiErrorEvent {
  type: "error";
  severity: string;
  message: string;
}

export interface GeminiResultEvent {
  type: "result";
  status: "success" | "error";
  stats?: {
    input_tokens: number;
    output_tokens: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
  error?: { message: string };
}

export type GeminiEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiErrorEvent
  | GeminiResultEvent;

export interface GeminiTurnResult {
  sessionId: string | null;
  finalResponse: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
  error: string | null;
}

/**
 * Process a stream of Gemini CLI events.
 * Sends text deltas via onChunk for streaming.
 */
export async function processGeminiTurn(
  events: AsyncGenerator<GeminiEvent>,
  sink: {
    onChunk: (text: string) => void;
    onComplete: (content: string) => void;
    onError: (error: string) => void;
  },
): Promise<GeminiTurnResult> {
  let sessionId: string | null = null;
  let finalResponse = "";
  let usage: GeminiTurnResult["usage"] = null;
  let error: string | null = null;

  for await (const event of events) {
    switch (event.type) {
      case "init":
        sessionId = event.session_id;
        break;

      case "message":
        if (event.role === "assistant") {
          if (event.delta) {
            sink.onChunk(event.content);
            finalResponse += event.content;
          } else {
            // Full message replaces accumulated content
            const delta = event.content.slice(finalResponse.length);
            if (delta) {
              sink.onChunk(delta);
            }
            finalResponse = event.content;
          }
        }
        break;

      case "result":
        if (event.status === "success") {
          if (event.stats) {
            usage = {
              inputTokens: event.stats.input_tokens,
              outputTokens: event.stats.output_tokens,
              cachedInputTokens: event.stats.cached ?? 0,
            };
          }
          sink.onComplete(finalResponse || "Done.");
        } else {
          error = event.error?.message ?? "Unknown error";
          sink.onError(error);
        }
        break;

      case "error":
        if (event.severity === "error") {
          error = event.message;
          sink.onError(event.message);
        }
        break;

      default:
        break;
    }
  }

  return { sessionId, finalResponse, usage, error };
}
