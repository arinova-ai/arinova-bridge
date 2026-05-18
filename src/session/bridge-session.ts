import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMessage {
  id?: number;
  role: "user" | "assistant";
  content: string;
  userMessage?: string;
  /** Who sent this message (username or agent name). */
  sender?: string;
  timestamp: number;
  /** Token count for this message (filled after recording). */
  tokenCount?: number;
  /** Provider finish reason (e.g. "end_turn", "max_tokens"). */
  finishReason?: string;
}

/** Row shape returned from the messages table. */
interface MessageRow {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  user_message: string | null;
  sender: string | null;
  timestamp: number;
  token_count: number | null;
  finish_reason: string | null;
}

// ---------------------------------------------------------------------------
// Model context-window sizes
// ---------------------------------------------------------------------------

/** Model context-window sizes (input tokens). */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  // OpenAI
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.1-codex-max": 400_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  // Gemini
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3-pro-preview": 1_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "gemini-2.5-flash-lite": 1_000_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Map model names to tiktoken model names for encoding. */
function getTiktokenModel(model?: string): TiktokenModel {
  if (!model) return "gpt-4o";
  // Claude models use cl100k_base (same as gpt-4)
  if (model.startsWith("claude")) return "gpt-4o";
  // GPT models
  if (model.startsWith("gpt-5") || model.startsWith("gpt-4")) return "gpt-4o";
  // Default
  return "gpt-4o";
}

/** Trigger compact when context usage reaches this fraction. */
const COMPACT_THRESHOLD = 0.5;

/** Number of messages to protect at the start of conversation. */
const PROTECT_FIRST_N = 2;

/** Number of messages to protect at the end of conversation. */
const PROTECT_LAST_N = 10;

/** Fallback maximum tokens for a compacted summary. */
export const SUMMARY_MAX_TOKENS = 750;

/** Keep compact prompts below Codex app-server's 1,048,576 character input cap. */
const COMPACT_INPUT_CHUNK_CHARS = 750_000;

/** Resolve context window for a model, with prefix fallback. */
function resolveContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key) || key.startsWith(model)) return value;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Calculate dynamic summary token budget: 5% of context window, min 500, max 2000. */
export function getSummaryMaxTokens(model?: string): number {
  const window = resolveContextWindow(model);
  return Math.min(2000, Math.max(500, Math.floor(window * 0.05)));
}

// ---------------------------------------------------------------------------
// Compact prompt builder — auto-detects task vs conversation style
// ---------------------------------------------------------------------------

/** Heuristics: task-oriented if messages contain commit hashes, card IDs, code blocks, etc. */
function isTaskOriented(text: string): boolean {
  // Commit hash: 7-40 hex chars that contain at least one letter (excludes pure digits like dates)
  return /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.test(text)
    || /\b[0-9a-f]{8}-/.test(text)            // UUID-style card ID
    || /```/.test(text)                        // code blocks
    || /\b(commit|merge|deploy|PR|review|bug|fix|feat)\b/i.test(text);
}

export function buildCompactPrompt(conversationText: string, tokenBudget: number, existingSummary?: string): string {
  const taskMode = isTaskOriented(conversationText + (existingSummary ?? ""));
  const budgetNote = `Token budget: ${tokenBudget} tokens max.`;

  if (taskMode) {
    const taskInstructions = [
      "Summarise this engineering conversation into the EXACT structured format below.",
      "Use bullet points under each heading. Omit a section if nothing applies — do NOT leave it empty.",
      "Preserve: commit hashes, card/ticket IDs, PR numbers, file paths, function names.",
      "",
      "## Active Task",
      "- [task description, current status: done / in-progress / blocked]",
      "",
      "## Key Decisions",
      "- [decision and rationale]",
      "",
      "## Modified Files",
      "- [file path — what changed]",
      "",
      "## Pending",
      "- [action item — owner]",
      "",
      "## Context",
      "- [other important context that doesn't fit above]",
      "",
      budgetNote,
    ].join("\n");

    return existingSummary
      ? `${taskInstructions}\n\nPrevious summary:\n${existingSummary}\n\nNew messages:\n${conversationText}`
      : `${taskInstructions}\n\nConversation:\n${conversationText}`;
  }

  // General conversation mode — structured
  const generalInstructions = [
    "請將以下對話整理成以下結構化格式。每個標題下用 bullet points 列出重點。若該區段無內容則省略，不要留空。",
    "",
    "## 重點摘要",
    "- [核心討論內容]",
    "",
    "## 決策紀錄",
    "- [決策及原因]",
    "",
    "## 待辦事項",
    "- [待完成項目 — 負責人]",
    "",
    budgetNote,
  ].join("\n");

  return existingSummary
    ? `${generalInstructions}\n\n先前摘要:\n${existingSummary}\n\n後續對話:\n${conversationText}`
    : `${generalInstructions}\n\n${conversationText}`;
}

// ---------------------------------------------------------------------------
// Tokenizer cache
// ---------------------------------------------------------------------------

const encoderCache = new Map<string, ReturnType<typeof encodingForModel>>();

function getEncoder(model?: string): ReturnType<typeof encodingForModel> {
  const tiktokenModel = getTiktokenModel(model);
  let enc = encoderCache.get(tiktokenModel);
  if (!enc) {
    enc = encodingForModel(tiktokenModel);
    encoderCache.set(tiktokenModel, enc);
  }
  return enc;
}

function countTokens(text: string, model?: string): number {
  try {
    const enc = getEncoder(model);
    return enc.encode(text).length;
  } catch {
    // Fallback to estimation if tokenizer fails
    return Math.ceil(text.length / 3.5);
  }
}

function extractUserCurrentMessage(content: string): string {
  const match = content.match(/<user-current-message>\s*([\s\S]*?)\s*<\/user-current-message>/i);
  return (match?.[1] ?? content).trim();
}

function compactMessageLength(message: SessionMessage): number {
  return `${message.sender ?? message.role}: ${message.content}\n`.length;
}

function splitLargeCompactMessage(message: SessionMessage, maxChars: number): SessionMessage[] {
  const prefixChars = `${message.sender ?? message.role}: \n`.length;
  const contentChunkChars = Math.max(1, maxChars - prefixChars);
  const chunks: SessionMessage[] = [];

  for (let offset = 0; offset < message.content.length; offset += contentChunkChars) {
    chunks.push({
      ...message,
      content: message.content.slice(offset, offset + contentChunkChars),
    });
  }

  return chunks;
}

function chunkMessagesForCompact(
  messages: SessionMessage[],
  maxChars = COMPACT_INPUT_CHUNK_CHARS,
): SessionMessage[][] {
  const chunks: SessionMessage[][] = [];
  let current: SessionMessage[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
  };

  for (const message of messages) {
    const pieces = compactMessageLength(message) > maxChars
      ? splitLargeCompactMessage(message, maxChars)
      : [message];

    for (const piece of pieces) {
      const pieceChars = compactMessageLength(piece);
      if (current.length > 0 && currentChars + pieceChars > maxChars) {
        flush();
      }
      current.push(piece);
      currentChars += pieceChars;
    }
  }

  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// BridgeSessionStore — SQLite backed
// ---------------------------------------------------------------------------

export class BridgeSessionStore {
  private db: InstanceType<typeof Database>;
  private logger: Logger;
  private stmts: ReturnType<typeof BridgeSessionStore.prepareStatements>;

  constructor(sessionsDir: string, logger: Logger) {
    this.logger = logger;
    mkdirSync(sessionsDir, { recursive: true });

    const dbPath = path.join(sessionsDir, "sessions.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    // ---- Schema (with migrations) ----------------------------------------

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_id   TEXT PRIMARY KEY,
        compacted_summary TEXT,
        model             TEXT,
        user_id           TEXT,
        username          TEXT,
        message_count     INTEGER NOT NULL DEFAULT 0,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        user_message    TEXT,
        sender          TEXT,
        timestamp       INTEGER NOT NULL,
        token_count     INTEGER,
        finish_reason   TEXT,
        FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conv
        ON messages(conversation_id, id)
    `);

    // ---- FTS5 full-text search -------------------------------------------

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        sender,
        content='messages',
        content_rowid='id',
        tokenize='unicode61'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, sender)
        VALUES (new.id, new.content, new.sender);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender)
        VALUES ('delete', old.id, old.content, old.sender);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, sender)
        VALUES ('delete', old.id, old.content, old.sender);
        INSERT INTO messages_fts(rowid, content, sender)
        VALUES (new.id, new.content, new.sender);
      END
    `);

    // Migrate: add columns if missing (for existing databases)
    const migrations = [
      "ALTER TABLE messages ADD COLUMN user_message TEXT",
      "ALTER TABLE messages ADD COLUMN token_count INTEGER",
      "ALTER TABLE messages ADD COLUMN finish_reason TEXT",
      "ALTER TABLE sessions ADD COLUMN model TEXT",
      "ALTER TABLE sessions ADD COLUMN user_id TEXT",
      "ALTER TABLE sessions ADD COLUMN username TEXT",
      "ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0",
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

    this.stmts = BridgeSessionStore.prepareStatements(this.db);
    logger.info(`bridge-session: SQLite store ready at ${dbPath}`);
  }

  private static prepareStatements(db: InstanceType<typeof Database>) {
    return {
      upsertSession: db.prepare(`
        INSERT INTO sessions (conversation_id, compacted_summary, model, user_id, username, created_at, updated_at)
        VALUES (@convId, NULL, @model, @userId, @username, @now, @now)
        ON CONFLICT(conversation_id) DO UPDATE SET
          model = COALESCE(@model, model),
          user_id = COALESCE(@userId, user_id),
          username = COALESCE(@username, username),
          updated_at = @now
      `),
      incrementCounters: db.prepare(`
        UPDATE sessions SET
          message_count = message_count + 1,
          total_tokens = total_tokens + @tokens,
          updated_at = @now
        WHERE conversation_id = @convId
      `),
      getSessionMeta: db.prepare(
        "SELECT conversation_id, model, user_id, username, message_count, total_tokens, created_at, updated_at FROM sessions WHERE conversation_id = ?",
      ),
      listSessionsFull: db.prepare(`
        SELECT conversation_id, model, user_id, username, message_count, total_tokens, created_at, updated_at
        FROM sessions ORDER BY updated_at DESC
      `),
      insertMessage: db.prepare(`
        INSERT INTO messages (
          conversation_id, role, content, user_message, sender, timestamp, token_count, finish_reason
        )
        VALUES (
          @convId, @role, @content, @userMessage, @sender, @timestamp, @tokenCount, @finishReason
        )
      `),
      getMessages: db.prepare(
        "SELECT id, conversation_id, role, content, user_message, sender, timestamp, token_count, finish_reason FROM messages WHERE conversation_id = ? ORDER BY id ASC",
      ),
      getRecentMessages: db.prepare(
        "SELECT * FROM (SELECT id, conversation_id, role, content, user_message, sender, timestamp, token_count, finish_reason FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 5) ORDER BY id ASC",
      ),
      getMessageCount: db.prepare(
        "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?",
      ),
      getTotalTokens: db.prepare(
        "SELECT COALESCE(SUM(token_count), 0) as total FROM messages WHERE conversation_id = ?",
      ),
      getSummary: db.prepare(
        "SELECT compacted_summary FROM sessions WHERE conversation_id = ?",
      ),
      setSummary: db.prepare(
        "UPDATE sessions SET compacted_summary = ?, updated_at = ? WHERE conversation_id = ?",
      ),
      deleteMessagesByIds: db.prepare(
        "DELETE FROM messages WHERE id IN (SELECT value FROM json_each(@ids))",
      ),
      deleteMessages: db.prepare(
        "DELETE FROM messages WHERE conversation_id = ?",
      ),
      deleteSession: db.prepare(
        "DELETE FROM sessions WHERE conversation_id = ?",
      ),
      listSessions: db.prepare(
        "SELECT conversation_id FROM sessions ORDER BY updated_at DESC",
      ),
      hasSession: db.prepare(
        "SELECT 1 FROM sessions WHERE conversation_id = ?",
      ),
      // FTS5 search
      ftsSearch: db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.user_message, m.sender, m.timestamp,
               m.token_count, m.finish_reason
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH @query
        ORDER BY fts.rank
        LIMIT @limit
      `),
      ftsSearchInSession: db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.user_message, m.sender, m.timestamp,
               m.token_count, m.finish_reason
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE messages_fts MATCH @query AND m.conversation_id = @convId
        ORDER BY fts.rank
        LIMIT @limit
      `),
    };
  }

  // ---- helpers -----------------------------------------------------------

  private toSessionMessage(row: MessageRow): SessionMessage {
    return {
      id: row.id,
      role: row.role as "user" | "assistant",
      content: row.content,
      userMessage: row.user_message ?? undefined,
      sender: row.sender ?? undefined,
      timestamp: row.timestamp,
      tokenCount: row.token_count ?? undefined,
      finishReason: row.finish_reason ?? undefined,
    };
  }

  private ensureSession(
    conversationId: string,
    meta?: { model?: string; userId?: string; username?: string },
  ): void {
    this.stmts.upsertSession.run({
      convId: conversationId,
      model: meta?.model ?? null,
      userId: meta?.userId ?? null,
      username: meta?.username ?? null,
      now: Date.now(),
    });
  }

  // ---- public API --------------------------------------------------------

  /** Record a user message with accurate token count. */
  addUserMessage(
    conversationId: string,
    content: string,
    sender?: string,
    opts?: { model?: string; userId?: string; username?: string },
  ): void {
    const model = opts?.model;
    this.ensureSession(conversationId, {
      model,
      userId: opts?.userId,
      username: opts?.username ?? sender,
    });
    const tokens = countTokens(content, model);
    const userMessage = extractUserCurrentMessage(content);
    this.stmts.insertMessage.run({
      convId: conversationId,
      role: "user",
      content,
      userMessage,
      sender: sender ?? null,
      timestamp: Date.now(),
      tokenCount: tokens,
      finishReason: null,
    });
    this.stmts.incrementCounters.run({ convId: conversationId, tokens, now: Date.now() });
  }

  /** Record an assistant response with accurate token count. */
  addAssistantMessage(
    conversationId: string,
    content: string,
    sender?: string,
    opts?: { model?: string; finishReason?: string },
  ): void {
    this.ensureSession(conversationId, { model: opts?.model });
    const tokens = countTokens(content, opts?.model);
    this.stmts.insertMessage.run({
      convId: conversationId,
      role: "assistant",
      content,
      userMessage: null,
      sender: sender ?? null,
      timestamp: Date.now(),
      tokenCount: tokens,
      finishReason: opts?.finishReason ?? null,
    });
    this.stmts.incrementCounters.run({ convId: conversationId, tokens, now: Date.now() });
  }

  /**
   * Build the full conversation context string to send to the provider.
   * Includes compacted summary (if any) + all remaining messages.
   */
  buildContext(conversationId: string): string {
    const parts: string[] = [];

    const summaryRow = this.stmts.getSummary.get(conversationId) as
      | { compacted_summary: string | null }
      | undefined;
    if (summaryRow?.compacted_summary) {
      parts.push(`[Conversation summary]\n${summaryRow.compacted_summary}\n[/Conversation summary]`);
    }

    // Only include the most recent 20 messages to keep context prefix manageable
    const rows = this.stmts.getRecentMessages.all(conversationId) as MessageRow[];
    for (const row of rows) {
      const sender = row.sender ?? row.role;
      // For user rows, always prefer the extracted user_message (clean original
      // input) over content (which may carry [Recent history] / [Fork context]
      // wrappers). Re-injecting a wrapped row into the next buildContext call
      // is what causes the recursive bloat that blew gina past the 200K limit.
      const messageContent = row.role === "user"
        ? (row.user_message?.trim() || row.content)
        : row.content;
      parts.push(`${sender}: ${messageContent}`);
    }

    return parts.join("\n");
  }

  /**
   * Calculate total tokens for the session context using stored token counts.
   * Falls back to re-counting if stored counts are incomplete.
   */
  estimateTokens(conversationId: string, model?: string): number {
    // Try fast path: sum stored token_count values
    const totalRow = this.stmts.getTotalTokens.get(conversationId) as { total: number };
    if (totalRow.total > 0) {
      // Add summary tokens if present
      const summaryRow = this.stmts.getSummary.get(conversationId) as
        | { compacted_summary: string | null }
        | undefined;
      const summaryTokens = summaryRow?.compacted_summary
        ? countTokens(summaryRow.compacted_summary, model)
        : 0;
      return totalRow.total + summaryTokens;
    }

    // Fallback: count all context text
    const context = this.buildContext(conversationId);
    return countTokens(context, model);
  }

  /**
   * Check if compaction is needed based on model context window.
   * Returns true if estimated tokens >= 50% of context window (Hermes-style).
   */
  needsCompact(conversationId: string, model?: string): boolean {
    const tokens = this.estimateTokens(conversationId, model);
    const window = this.getContextWindow(model);
    return tokens >= window * COMPACT_THRESHOLD;
  }

  /**
   * Compact the session: protect first N and last N messages, compress middle.
   * `summariser` is called with the middle messages to produce a summary string.
   */
  async compact(
    conversationId: string,
    summariser: (messages: SessionMessage[], existingSummary?: string) => Promise<string>,
    opts?: { model?: string; compactInputChunkChars?: number },
  ): Promise<void> {
    const rows = this.stmts.getMessages.all(conversationId) as MessageRow[];
    const total = rows.length;
    const minMessages = PROTECT_FIRST_N + PROTECT_LAST_N;

    if (total <= minMessages) return;

    // Partition: [protected first] [middle to compact] [protected last]
    const protectedFirst = rows.slice(0, PROTECT_FIRST_N);
    const protectedLast = rows.slice(-PROTECT_LAST_N);
    const middleRows = rows.slice(PROTECT_FIRST_N, total - PROTECT_LAST_N);

    if (middleRows.length === 0) return;

    const middleMessages = middleRows.map((r) => this.toSessionMessage(r));

    const summaryRow = this.stmts.getSummary.get(conversationId) as
      | { compacted_summary: string | null }
      | undefined;

    const chunks = chunkMessagesForCompact(middleMessages, opts?.compactInputChunkChars);
    let summary = summaryRow?.compacted_summary ?? undefined;

    if (chunks.length > 1) {
      this.logger.info(
        `bridge-session: compacting ${conversationId} in ${chunks.length} chunks ` +
        `(${middleMessages.length} messages)`,
      );
    }

    for (const chunk of chunks) {
      summary = await summariser(chunk, summary);
    }

    if (summary === undefined) return;

    // Enforce dynamic summary token budget — truncate if exceeded
    const maxTokens = getSummaryMaxTokens(opts?.model);
    const summaryTokens = countTokens(summary);
    if (summaryTokens > maxTokens) {
      const enc = getEncoder();
      const tokenIds = enc.encode(summary);
      summary = enc.decode(tokenIds.slice(0, maxTokens)) + "\n[...truncated]";
      this.logger.warn(
        `bridge-session: summary exceeded budget (${summaryTokens} > ${maxTokens}), truncated`,
      );
    }

    // Delete only the middle messages, keep first N and last N
    const idsToDelete = middleRows.map((r) => r.id);
    const doCompact = this.db.transaction(() => {
      this.stmts.setSummary.run(summary, Date.now(), conversationId);
      this.stmts.deleteMessagesByIds.run({ ids: JSON.stringify(idsToDelete) });
    });
    doCompact();

    this.logger.info(
      `bridge-session: compacted ${conversationId} — ` +
      `protected first ${protectedFirst.length} + last ${protectedLast.length}, ` +
      `compressed ${middleRows.length} middle messages → summary (${summary.length} chars)`,
    );
  }

  /** Clear a session (e.g. /new). */
  clear(conversationId: string): void {
    const doClear = this.db.transaction(() => {
      this.stmts.deleteMessages.run(conversationId);
      this.stmts.deleteSession.run(conversationId);
    });
    doClear();
    this.logger.info(`bridge-session: cleared ${conversationId}`);
  }

  // ---- FTS5 search -------------------------------------------------------

  /** Search across all sessions. Returns matching messages ranked by relevance. */
  search(query: string, limit = 20): SessionMessage[] {
    const sanitised = this.sanitiseFtsQuery(query);
    if (!sanitised) return [];
    try {
      const rows = this.stmts.ftsSearch.all({ query: sanitised, limit }) as MessageRow[];
      return rows.map((r) => this.toSessionMessage(r));
    } catch (err) {
      this.logger.warn(`bridge-session: FTS search failed: ${err}`);
      return [];
    }
  }

  /** Search within a specific session. */
  searchInSession(conversationId: string, query: string, limit = 20): SessionMessage[] {
    const sanitised = this.sanitiseFtsQuery(query);
    if (!sanitised) return [];
    try {
      const rows = this.stmts.ftsSearchInSession.all({
        query: sanitised,
        convId: conversationId,
        limit,
      }) as MessageRow[];
      return rows.map((r) => this.toSessionMessage(r));
    } catch (err) {
      this.logger.warn(`bridge-session: FTS search failed: ${err}`);
      return [];
    }
  }

  /** Sanitise user input for FTS5 query syntax. */
  private sanitiseFtsQuery(query: string): string {
    // Remove characters that break FTS5 syntax
    let sanitised = query.replace(/[{}()[\]:^~!@#$%&*+=|\\<>]/g, " ");
    // Wrap hyphenated/dotted terms in quotes
    sanitised = sanitised.replace(/\b([\w]+-[\w]+(?:-[\w]+)*)\b/g, '"$1"');
    sanitised = sanitised.replace(/\b([\w]+\.[\w]+(?:\.[\w]+)*)\b/g, '"$1"');
    return sanitised.trim();
  }

  // ---- utility -----------------------------------------------------------

  /** Get the context window size for a given model. */
  getContextWindow(model?: string): number {
    return resolveContextWindow(model);
  }

  /** List all active session IDs. */
  listSessionIds(): string[] {
    const rows = this.stmts.listSessions.all() as { conversation_id: string }[];
    return rows.map((r) => r.conversation_id);
  }

  /** Get message count for a session. */
  getMessageCount(conversationId: string): number {
    const row = this.stmts.getMessageCount.get(conversationId) as { cnt: number };
    return row.cnt;
  }

  /** Check if a session exists. */
  has(conversationId: string): boolean {
    return !!this.stmts.hasSession.get(conversationId);
  }

  /** Get all messages for a session. */
  getMessages(conversationId: string): SessionMessage[] {
    const rows = this.stmts.getMessages.all(conversationId) as MessageRow[];
    return rows.map((r) => this.toSessionMessage(r));
  }

  /** Get session metadata. */
  getSessionMeta(conversationId: string): SessionMeta | null {
    const row = this.stmts.getSessionMeta.get(conversationId) as SessionMetaRow | undefined;
    return row ? toSessionMeta(row) : null;
  }

  /** List all sessions with metadata. */
  listSessions(): SessionMeta[] {
    const rows = this.stmts.listSessionsFull.all() as SessionMetaRow[];
    return rows.map(toSessionMeta);
  }
}

// ---------------------------------------------------------------------------
// Session metadata type
// ---------------------------------------------------------------------------

export interface SessionMeta {
  conversationId: string;
  model?: string;
  userId?: string;
  username?: string;
  messageCount: number;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionMetaRow {
  conversation_id: string;
  model: string | null;
  user_id: string | null;
  username: string | null;
  message_count: number;
  total_tokens: number;
  created_at: number;
  updated_at: number;
}

function toSessionMeta(row: SessionMetaRow): SessionMeta {
  return {
    conversationId: row.conversation_id,
    model: row.model ?? undefined,
    userId: row.user_id ?? undefined,
    username: row.username ?? undefined,
    messageCount: row.message_count,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
