// Codex JSONL event types (subset needed for bridge)

export type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadErrorEvent;

export interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

export interface TurnStartedEvent {
  type: "turn.started";
}

export interface TurnCompletedEvent {
  type: "turn.completed";
  usage: TokenUsage;
}

export interface TurnFailedEvent {
  type: "turn.failed";
  error: { message: string };
}

export interface ItemStartedEvent {
  type: "item.started";
  item: ThreadItem;
}

export interface ItemUpdatedEvent {
  type: "item.updated";
  item: ThreadItem;
}

export interface ItemCompletedEvent {
  type: "item.completed";
  item: ThreadItem;
}

export interface ThreadErrorEvent {
  type: "error";
  message: string;
}

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export type ThreadItem =
  | AgentMessageItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | ReasoningItem
  | TodoListItem
  | ErrorItem;

export interface AgentMessageItem {
  id: string;
  type: "agent_message";
  text: string;
}

export interface CommandExecutionItem {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: string;
}

export interface FileChangeItem {
  id: string;
  type: "file_change";
  changes: Array<{ path: string; kind: string }>;
  status: string;
}

export interface McpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  status: string;
}

export interface WebSearchItem {
  id: string;
  type: "web_search";
  query: string;
}

export interface ReasoningItem {
  id: string;
  type: "reasoning";
  text: string;
}

export interface TodoListItem {
  id: string;
  type: "todo_list";
  items: Array<{ text: string; completed: boolean }>;
}

export interface ErrorItem {
  id: string;
  type: "error";
  message: string;
}

// --- Event processing ---

export interface TurnResult {
  threadId: string | null;
  finalResponse: string;
  usage: TokenUsage | null;
  error: string | null;
}

/**
 * Process a stream of Codex ThreadEvents.
 * Sends text deltas (not full replacement) via onChunk for consistent behavior
 * across all providers.
 * Returns the turn result with thread_id, final response, and token usage.
 */
export async function processTurn(
  events: AsyncGenerator<ThreadEvent>,
  sink: {
    onChunk: (text: string) => void;
    onComplete: (content: string) => void;
    onError: (error: string) => void;
  },
): Promise<TurnResult> {
  let threadId: string | null = null;
  let finalResponse = "";
  let usage: TokenUsage | null = null;
  let error: string | null = null;
  let lastSentLength = 0;

  for await (const event of events) {
    switch (event.type) {
      case "thread.started":
        threadId = event.thread_id;
        break;

      case "item.started":
      case "item.updated":
        if (event.item.type === "agent_message" && event.item.text) {
          // Send only the new delta portion
          const delta = event.item.text.slice(lastSentLength);
          if (delta) {
            sink.onChunk(delta);
            lastSentLength = event.item.text.length;
          }
        }
        break;

      case "item.completed":
        if (event.item.type === "agent_message") {
          // Send any remaining delta
          const delta = event.item.text.slice(lastSentLength);
          if (delta) {
            sink.onChunk(delta);
          }
          finalResponse = event.item.text;
          lastSentLength = 0; // Reset for next item
        }
        break;

      case "turn.completed":
        usage = event.usage;
        sink.onComplete(finalResponse || "Done.");
        break;

      case "turn.failed":
        error = event.error.message;
        sink.onError(event.error.message);
        break;

      case "error":
        error = event.message;
        sink.onError(event.message);
        break;

      // turn.started → skip
      default:
        break;
    }
  }

  return { threadId, finalResponse, usage, error };
}
