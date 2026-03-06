import type { FetchHistoryOptions, FetchHistoryResult } from "../providers/types.js";

export interface UploadResult {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface TaskAttachment {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  url: string;
}

export interface Note {
  id: string;
  conversationId: string;
  creatorId: string;
  creatorType: "user" | "agent";
  creatorName: string;
  agentId?: string;
  agentName?: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommandContext {
  conversationId: string;
  sendChunk: (text: string) => void;
  sendComplete: (text: string, options?: { mentions?: string[] }) => void;
  sendError: (text: string) => void;
  uploadFile: (file: Uint8Array, fileName: string, fileType?: string) => Promise<UploadResult>;
  attachments?: TaskAttachment[];
  /** "direct" or "group" */
  conversationType?: string;
  /** User ID of the human who sent the message. */
  senderUserId?: string;
  /** Username of the human who sent the message. */
  senderUsername?: string;
  /** Other agents in the conversation (group only). */
  members?: { agentId: string; agentName: string }[];
  /** Fetch full conversation history with pagination. */
  fetchHistory?: (options?: FetchHistoryOptions) => Promise<FetchHistoryResult>;
  /** Notes API */
  listNotes?: (options?: { before?: string; limit?: number }) => Promise<{ notes: Note[]; hasMore: boolean; nextCursor?: string }>;
  createNote?: (body: { title: string; content?: string }) => Promise<Note>;
  updateNote?: (noteId: string, body: { title?: string; content?: string }) => Promise<Note>;
  deleteNote?: (noteId: string) => Promise<void>;
}

export type CommandResult = { handled: true } | { handled: false };
