import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ForkStatus = "running" | "completed" | "failed" | "cancelled";

export interface ForkJob {
  id: string;
  parentAgent: string;
  task: string;
  status: ForkStatus;
  result: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  model: string | null;
}

interface ForkJobRow {
  id: string;
  parent_agent: string;
  task: string;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  model: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_FORKS_PER_AGENT = 5;
export const FORK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_TASK_CHARS = 100_000;
export const MAX_RESULT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// ForkStore
// ---------------------------------------------------------------------------

export class ForkStore {
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
  };

  constructor(
    dbDir: string,
    private logger: Logger,
  ) {
    mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "fork.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
    this.prepareStatements();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fork_jobs (
        id            TEXT PRIMARY KEY,
        parent_agent  TEXT NOT NULL,
        task          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'running',
        result        TEXT,
        created_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        duration_ms   INTEGER,
        model         TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fork_parent ON fork_jobs (parent_agent)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fork_status ON fork_jobs (status)
    `);
  }

  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO fork_jobs (id, parent_agent, task, status, created_at, model)
        VALUES (@id, @parentAgent, @task, 'running', @createdAt, @model)
      `),
      getById: this.db.prepare(`SELECT * FROM fork_jobs WHERE id = ?`),
      listByParent: this.db.prepare(`SELECT * FROM fork_jobs WHERE parent_agent = ? ORDER BY created_at DESC`),
      listRunning: this.db.prepare(`SELECT * FROM fork_jobs WHERE status = 'running' ORDER BY created_at`),
      listAll: this.db.prepare(`SELECT * FROM fork_jobs ORDER BY created_at DESC LIMIT 50`),
      countRunningByParent: this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM fork_jobs WHERE parent_agent = ? AND status = 'running'`,
      ),
      complete: this.db.prepare(`
        UPDATE fork_jobs SET status = @status, result = @result, completed_at = @completedAt, duration_ms = @durationMs
        WHERE id = @id
      `),
      cancel: this.db.prepare(`
        UPDATE fork_jobs SET status = 'cancelled', completed_at = @completedAt, duration_ms = @durationMs
        WHERE id = @id AND status = 'running'
      `),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  add(parentAgent: string, task: string, model?: string): ForkJob {
    const count = (this.stmts.countRunningByParent.get(parentAgent) as { cnt: number }).cnt;
    if (count >= MAX_FORKS_PER_AGENT) {
      throw new Error(`Agent "${parentAgent}" already has ${MAX_FORKS_PER_AGENT} running fork jobs (limit reached)`);
    }

    if (task.length > MAX_TASK_CHARS) {
      throw new Error(`Task exceeds ${MAX_TASK_CHARS} character limit (got ${task.length})`);
    }

    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    this.stmts.insert.run({
      id,
      parentAgent,
      task,
      createdAt: now,
      model: model ?? null,
    });

    return {
      id,
      parentAgent,
      task,
      status: "running",
      result: null,
      createdAt: now,
      completedAt: null,
      durationMs: null,
      model: model ?? null,
    };
  }

  get(id: string): ForkJob | null {
    const row = this.stmts.getById.get(id) as ForkJobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  listByParent(parentAgent: string): ForkJob[] {
    const rows = this.stmts.listByParent.all(parentAgent) as ForkJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  listRunning(): ForkJob[] {
    const rows = this.stmts.listRunning.all([]) as ForkJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  listAll(): ForkJob[] {
    const rows = this.stmts.listAll.all([]) as ForkJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  countRunningByParent(parentAgent: string): number {
    return (this.stmts.countRunningByParent.get(parentAgent) as { cnt: number }).cnt;
  }

  complete(id: string, status: "completed" | "failed", result: string): void {
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

  close(): void {
    this.db.close();
  }

  private rowToJob(row: ForkJobRow): ForkJob {
    return {
      id: row.id,
      parentAgent: row.parent_agent,
      task: row.task,
      status: row.status as ForkStatus,
      result: row.result,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      model: row.model,
    };
  }
}
