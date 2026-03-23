import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export type ConversationStatus = "ready" | "busy" | "done" | "error";

export interface Conversation {
  convId: string;
  threadId: string | null;
  cwd: string | null;
  model: string | null;
  status: ConversationStatus;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface BridgeDb {
  getConversation(convId: string): Conversation | null;
  upsertConversation(
    convId: string,
    data: Partial<Pick<Conversation, "threadId" | "cwd" | "model" | "status">>,
  ): void;
  updateStatus(convId: string, status: ConversationStatus): void;
  addTokenUsage(convId: string, usage: TokenUsage): void;
  getRunningConversations(): Conversation[];
  getAllConversations(): Conversation[];
  resetConversation(convId: string, cwd?: string | null): void;
  // Rate limit cache
  saveRateLimitCache(json: string): void;
  loadRateLimitCache(): string | null;
}

export function initDb(dbPath: string): BridgeDb {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_cache (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conv_id             TEXT PRIMARY KEY,
      thread_id           TEXT,
      cwd                 TEXT,
      model               TEXT,
      status              TEXT NOT NULL DEFAULT 'ready',
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    )
  `);

  const stmts = {
    get: db.prepare("SELECT * FROM conversations WHERE conv_id = ?"),
    upsert: db.prepare(`
      INSERT INTO conversations (conv_id, thread_id, cwd, model, status, created_at, updated_at)
      VALUES (@convId, @threadId, @cwd, @model, @status, @now, @now)
      ON CONFLICT(conv_id) DO UPDATE SET
        thread_id = COALESCE(@threadId, thread_id),
        cwd = CASE WHEN @cwd IS NOT NULL THEN @cwd ELSE cwd END,
        model = CASE WHEN @model IS NOT NULL THEN @model ELSE model END,
        status = COALESCE(@status, status),
        updated_at = @now
    `),
    updateStatus: db.prepare(
      "UPDATE conversations SET status = ?, updated_at = ? WHERE conv_id = ?",
    ),
    addTokens: db.prepare(`
      UPDATE conversations SET
        input_tokens = input_tokens + @inputTokens,
        cached_input_tokens = cached_input_tokens + @cachedInputTokens,
        output_tokens = output_tokens + @outputTokens,
        updated_at = @now
      WHERE conv_id = @convId
    `),
    getRunning: db.prepare(
      "SELECT * FROM conversations WHERE status = 'busy'",
    ),
    getAll: db.prepare(
      "SELECT * FROM conversations WHERE thread_id IS NOT NULL",
    ),
    saveRateLimit: db.prepare(`
      INSERT INTO rate_limit_cache (id, data, updated_at) VALUES (1, @data, @now)
      ON CONFLICT(id) DO UPDATE SET data = @data, updated_at = @now
    `),
    loadRateLimit: db.prepare("SELECT data FROM rate_limit_cache WHERE id = 1"),
    reset: db.prepare(`
      UPDATE conversations SET
        thread_id = NULL,
        cwd = @cwd,
        status = 'ready',
        input_tokens = 0,
        cached_input_tokens = 0,
        output_tokens = 0,
        updated_at = @now
      WHERE conv_id = @convId
    `),
  };

  function toConversation(row: unknown): Conversation {
    const r = row as Record<string, unknown>;
    return {
      convId: r.conv_id as string,
      threadId: r.thread_id as string | null,
      cwd: r.cwd as string | null,
      model: r.model as string | null,
      status: r.status as ConversationStatus,
      inputTokens: r.input_tokens as number,
      cachedInputTokens: r.cached_input_tokens as number,
      outputTokens: r.output_tokens as number,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  function now(): string {
    return new Date().toISOString();
  }

  return {
    getConversation(convId: string): Conversation | null {
      const row = stmts.get.get(convId);
      return row ? toConversation(row) : null;
    },

    upsertConversation(convId, data) {
      stmts.upsert.run({
        convId,
        threadId: data.threadId ?? null,
        cwd: data.cwd ?? null,
        model: data.model ?? null,
        status: data.status ?? "ready",
        now: now(),
      });
    },

    updateStatus(convId, status) {
      stmts.updateStatus.run(status, now(), convId);
    },

    addTokenUsage(convId, usage) {
      stmts.addTokens.run({
        convId,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        now: now(),
      });
    },

    getRunningConversations(): Conversation[] {
      return (stmts.getRunning.all() as unknown[]).map(toConversation);
    },

    getAllConversations(): Conversation[] {
      return (stmts.getAll.all() as unknown[]).map(toConversation);
    },

    resetConversation(convId, cwd) {
      stmts.reset.run({
        convId,
        cwd: cwd ?? null,
        now: now(),
      });
    },

    saveRateLimitCache(json: string) {
      stmts.saveRateLimit.run({ data: json, now: now() });
    },

    loadRateLimitCache(): string | null {
      const row = stmts.loadRateLimit.get() as { data: string } | undefined;
      return row?.data ?? null;
    },
  };
}
