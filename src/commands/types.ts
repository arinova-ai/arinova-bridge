export interface CommandContext {
  conversationId: string;
  sendChunk: (text: string) => void;
  sendComplete: (text: string) => void;
  sendError: (text: string) => void;
}

export type CommandResult = { handled: true } | { handled: false };
