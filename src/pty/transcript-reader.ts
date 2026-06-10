import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";

// One parsed line of the Claude CLI session transcript JSONL. The file is
// the CLI's internal session log (also backs `claude --resume`) — we only
// type the fields we read and pass everything else through.
export interface TranscriptLine {
  type: string;
  uuid?: string;
  sessionId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    id?: string;
    stop_reason?: string | null;
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          thinking?: string;
          name?: string;
          input?: unknown;
        }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  [key: string]: unknown;
}

// The interactive CLI stores transcripts under
// <configDir>/projects/<encoded-cwd>/<session-uuid>.jsonl where the cwd
// encoding replaces every non-alphanumeric character with `-`
// (verified: /Users/x/.claude-mem → -Users-x--claude-mem).
export function transcriptPathFor(cwd: string, sessionId: string): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(configDir, "projects", encoded, `${sessionId}.jsonl`);
}

/**
 * Incremental tailer for a session transcript JSONL file.
 *
 * The CLI appends one line per event *as the turn progresses* (each
 * assistant message lands when its content blocks complete — not
 * character-by-character, and not only at turn end). Polling is used
 * instead of fs.watch because the file may not exist yet when the
 * reader starts, and poll() doubles as a synchronous drain at turn end.
 *
 * Events: 'line' (every parsed line), 'assistant' (assistant lines only).
 */
export class TranscriptReader extends EventEmitter {
  private offset = 0;
  private remainder = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly filePath: string,
    private pollMs = 200,
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Read and emit everything currently on disk. Safe to call manually
   *  (used as a final drain before resolving a turn). */
  poll(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return; // file not created yet
    }
    if (stat.size <= this.offset) return;

    let chunk: string;
    const fd = fs.openSync(this.filePath, "r");
    try {
      const buf = Buffer.alloc(stat.size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = stat.size;
      chunk = this.remainder + buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    const lines = chunk.split("\n");
    this.remainder = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line) as TranscriptLine;
      } catch {
        continue; // malformed/truncated line — skip
      }
      this.emit("line", parsed);
      if (parsed.type === "assistant") {
        this.emit("assistant", parsed);
      }
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}
