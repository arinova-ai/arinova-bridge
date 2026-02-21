export interface UploadResult {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: number;
}

export interface CommandContext {
  conversationId: string;
  sendChunk: (text: string) => void;
  sendComplete: (text: string) => void;
  sendError: (text: string) => void;
  uploadFile: (file: Uint8Array, fileName: string, fileType?: string) => Promise<UploadResult>;
}

export type CommandResult = { handled: true } | { handled: false };
