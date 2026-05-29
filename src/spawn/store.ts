import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpawnStatus = "running" | "completed" | "failed" | "cancelled";

export interface SpawnJob {
  id: string;
  parentAgent: string;
  targetAgent: string;
  context: string;
  status: SpawnStatus;
  result: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  model: string | null;
  costUsd: number | null;
}

interface SpawnJobRow {
  id: string;
  parent_agent: string;
  target_agent: string;
  context: string;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  model: string | null;
  cost_usd: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_SPAWNS_PER_AGENT = 3;
export const SPAWN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_CONTEXT_CHARS = 100_000;
export const MAX_RESULT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// SpawnStore
// ---------------------------------------------------------------------------

export class SpawnStore {
  private db: InstanceType<typeof Database>;
  private stmts!: {
    insert: ReturnType<InstanceType<typeof Database>["prepare"]>;
    getById: ReturnType<InstanceType<typeof Database>["prepare"]>;
    listByParent: ReturnType<InstanceType<typeof Database>["prepare"]>;
    listRunning: ReturnType<InstanceType<typeof Database>["prepare"]>;
    listAll: ReturnType<InstanceType<typeof Database>["prepare"]>;
    countRunningByParent: ReturnType<InstanceType<typeof Database>["prepare"]>;
    complete: ReturnType<InstanceType<typeof Database>["prepare"]>;
    cancel: ReturnType<InstanceType<typeof Database>["prepare"]>;
    appendLog: ReturnType<InstanceType<typeof Database>["prepare"]>;
    getLogs: ReturnType<InstanceType<typeof Database>["prepare"]>;
    cleanupLogs: ReturnType<InstanceType<typeof Database>["prepare"]>;
  };

  constructor(
    dbDir: string,
    private logger: Logger,
  ) {
    mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "spawn.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
    this.prepareStatements();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spawn_jobs (
        id            TEXT PRIMARY KEY,
        parent_agent  TEXT NOT NULL,
        target_agent  TEXT NOT NULL,
        context       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'running',
        result        TEXT,
        created_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        duration_ms   INTEGER,
        model         TEXT,
        cost_usd      REAL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spawn_parent ON spawn_jobs (parent_agent)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spawn_status ON spawn_jobs (status)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spawn_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spawn_logs_job ON spawn_logs (job_id)
    `);
  }

  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO spawn_jobs (id, parent_agent, target_agent, context, status, created_at, model)
        VALUES (@id, @parentAgent, @targetAgent, @context, 'running', @createdAt, @model)
      `),
      getById: this.db.prepare(`SELECT * FROM spawn_jobs WHERE id = ?`),
      listByParent: this.db.prepare(`SELECT * FROM spawn_jobs WHERE parent_agent = ? ORDER BY created_at DESC`),
      listRunning: this.db.prepare(`SELECT * FROM spawn_jobs WHERE status = 'running' ORDER BY created_at`),
      listAll: this.db.prepare(`SELECT * FROM spawn_jobs ORDER BY created_at DESC LIMIT 50`),
      countRunningByParent: this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM spawn_jobs WHERE parent_agent = ? AND status = 'running'`,
      ),
      complete: this.db.prepare(`
        UPDATE spawn_jobs SET status = @status, result = @result, completed_at = @completedAt, duration_ms = @durationMs, cost_usd = @costUsd
        WHERE id = @id
      `),
      cancel: this.db.prepare(`
        UPDATE spawn_jobs SET status = 'cancelled', completed_at = @completedAt, duration_ms = @durationMs
        WHERE id = @id AND status = 'running'
      `),
      appendLog: this.db.prepare(`
        INSERT INTO spawn_logs (job_id, content, created_at) VALUES (@jobId, @content, @createdAt)
      `),
      getLogs: this.db.prepare(`
        SELECT content, created_at FROM spawn_logs WHERE job_id = ? ORDER BY id ASC
      `),
      cleanupLogs: this.db.prepare(`
        DELETE FROM spawn_logs WHERE job_id IN (
          SELECT id FROM spawn_jobs WHERE completed_at IS NOT NULL AND completed_at < ?
        )
      `),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  add(parentAgent: string, targetAgent: string, context: string, model?: string): SpawnJob {
    const count = (this.stmts.countRunningByParent.get(parentAgent) as { cnt: number }).cnt;
    if (count >= MAX_SPAWNS_PER_AGENT) {
      throw new Error(`Agent "${parentAgent}" already has ${MAX_SPAWNS_PER_AGENT} running spawn jobs (limit reached)`);
    }

    if (context.length > MAX_CONTEXT_CHARS) {
      throw new Error(`Context exceeds ${MAX_CONTEXT_CHARS} character limit (got ${context.length})`);
    }

    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    this.stmts.insert.run({
      id,
      parentAgent,
      targetAgent,
      context,
      createdAt: now,
      model: model ?? null,
    });

    return {
      id,
      parentAgent,
      targetAgent,
      context,
      status: "running",
      result: null,
      createdAt: now,
      completedAt: null,
      durationMs: null,
      model: model ?? null,
      costUsd: null,
    };
  }

  get(id: string): SpawnJob | null {
    const row = this.stmts.getById.get(id) as SpawnJobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  listByParent(parentAgent: string): SpawnJob[] {
    const rows = this.stmts.listByParent.all(parentAgent) as SpawnJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  listRunning(): SpawnJob[] {
    const rows = this.stmts.listRunning.all([]) as SpawnJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  listAll(): SpawnJob[] {
    const rows = this.stmts.listAll.all([]) as SpawnJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  countRunningByParent(parentAgent: string): number {
    return (this.stmts.countRunningByParent.get(parentAgent) as { cnt: number }).cnt;
  }

  complete(id: string, status: "completed" | "failed", result: string, costUsd?: number): void {
    const job = this.get(id);
    if (!job) return;

    const truncatedResult =
      result.length > MAX_RESULT_CHARS ? result.slice(0, MAX_RESULT_CHARS) + "\n...(truncated)" : result;

    const now = Date.now();
    this.stmts.complete.run({
      id,
      status,
      result: truncatedResult,
      completedAt: now,
      durationMs: now - job.createdAt,
      costUsd: costUsd ?? null,
    });
  }

  cancel(id: string): boolean {
    const job = this.get(id);
    if (!job || job.status !== "running") return false;

    const now = Date.now();
    this.stmts.cancel.run({
      id,
      completedAt: now,
      durationMs: now - job.createdAt,
    });
    return true;
  }

  appendLog(jobId: string, content: string): void {
    this.stmts.appendLog.run({ jobId, content, createdAt: Date.now() });
  }

  getLogs(jobId: string): Array<{ content: string; createdAt: number }> {
    const rows = this.stmts.getLogs.all(jobId) as Array<{ content: string; created_at: number }>;
    return rows.map((r) => ({ content: r.content, createdAt: r.created_at }));
  }

  /** Remove logs for jobs completed more than `maxAgeMs` ago. */
  cleanupOldLogs(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.stmts.cleanupLogs.run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private rowToJob(row: SpawnJobRow): SpawnJob {
    return {
      id: row.id,
      parentAgent: row.parent_agent,
      targetAgent: row.target_agent,
      context: row.context,
      status: row.status as SpawnStatus,
      result: row.result,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      model: row.model,
      costUsd: row.cost_usd,
    };
  }
}
