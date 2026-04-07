import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronJob {
  id: string;
  agentName: string;
  cronExpr: string;
  message: string;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
  maxRuns: number | null;
  enabled: boolean;
}

interface CronJobRow {
  id: string;
  agent_name: string;
  cron_expr: string;
  message: string;
  created_at: number;
  last_run_at: number | null;
  run_count: number;
  max_runs: number | null;
  enabled: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cron jobs per agent. */
export const MAX_JOBS_PER_AGENT = 10;

/** Minimum cron interval — reject expressions that fire more often than once per minute. */
export const MIN_INTERVAL_MINUTES = 1;

// ---------------------------------------------------------------------------
// CronStore
// ---------------------------------------------------------------------------

export class CronStore {
  private db: InstanceType<typeof Database>;
  private stmts!: {
    insert: ReturnType<InstanceType<typeof Database>["prepare"]>;
    getById: ReturnType<InstanceType<typeof Database>["prepare"]>;
    listByAgent: ReturnType<InstanceType<typeof Database>["prepare"]>;
    listEnabled: ReturnType<InstanceType<typeof Database>["prepare"]>;
    deleteById: ReturnType<InstanceType<typeof Database>["prepare"]>;
    deleteByAgent: ReturnType<InstanceType<typeof Database>["prepare"]>;
    countByAgent: ReturnType<InstanceType<typeof Database>["prepare"]>;
    recordRun: ReturnType<InstanceType<typeof Database>["prepare"]>;
    disable: ReturnType<InstanceType<typeof Database>["prepare"]>;
  };

  constructor(dbDir: string, private logger: Logger) {
    mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "cron.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
    this.prepareStatements();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id          TEXT PRIMARY KEY,
        agent_name  TEXT NOT NULL,
        cron_expr   TEXT NOT NULL,
        message     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_run_at INTEGER,
        run_count   INTEGER NOT NULL DEFAULT 0,
        max_runs    INTEGER,
        enabled     INTEGER NOT NULL DEFAULT 1
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_agent ON cron_jobs (agent_name)
    `);
  }

  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO cron_jobs (id, agent_name, cron_expr, message, created_at, max_runs)
        VALUES (@id, @agentName, @cronExpr, @message, @createdAt, @maxRuns)
      `),
      getById: this.db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`),
      listByAgent: this.db.prepare(`SELECT * FROM cron_jobs WHERE agent_name = ? ORDER BY created_at`),
      listEnabled: this.db.prepare(`SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY agent_name, created_at`),
      deleteById: this.db.prepare(`DELETE FROM cron_jobs WHERE id = ?`),
      deleteByAgent: this.db.prepare(`DELETE FROM cron_jobs WHERE agent_name = ?`),
      countByAgent: this.db.prepare(`SELECT COUNT(*) AS cnt FROM cron_jobs WHERE agent_name = ?`),
      recordRun: this.db.prepare(`UPDATE cron_jobs SET last_run_at = @now, run_count = run_count + 1 WHERE id = @id`),
      disable: this.db.prepare(`UPDATE cron_jobs SET enabled = 0 WHERE id = ?`),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  add(agentName: string, cronExpr: string, message: string, maxRuns?: number): CronJob {
    const count = (this.stmts.countByAgent.get(agentName) as { cnt: number }).cnt;
    if (count >= MAX_JOBS_PER_AGENT) {
      throw new Error(`Agent "${agentName}" already has ${MAX_JOBS_PER_AGENT} cron jobs (limit reached)`);
    }

    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    this.stmts.insert.run({
      id,
      agentName,
      cronExpr,
      message,
      createdAt: now,
      maxRuns: maxRuns ?? null,
    });

    return {
      id,
      agentName,
      cronExpr,
      message,
      createdAt: now,
      lastRunAt: null,
      runCount: 0,
      maxRuns: maxRuns ?? null,
      enabled: true,
    };
  }

  get(id: string): CronJob | null {
    const row = this.stmts.getById.get(id) as CronJobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  listByAgent(agentName: string): CronJob[] {
    const rows = this.stmts.listByAgent.all(agentName) as CronJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  listEnabled(): CronJob[] {
    const rows = this.stmts.listEnabled.all([]) as CronJobRow[];
    return rows.map((r) => this.rowToJob(r));
  }

  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }

  deleteAllByAgent(agentName: string): number {
    const result = this.stmts.deleteByAgent.run(agentName);
    return result.changes;
  }

  recordRun(id: string): void {
    this.stmts.recordRun.run({ id, now: Date.now() });

    // Check max_runs and auto-disable
    const job = this.get(id);
    if (job && job.maxRuns !== null && job.runCount >= job.maxRuns) {
      this.stmts.disable.run(id);
      this.logger.info(`cron[${id}] reached max_runs=${job.maxRuns}, auto-disabled`);
    }
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private rowToJob(row: CronJobRow): CronJob {
    return {
      id: row.id,
      agentName: row.agent_name,
      cronExpr: row.cron_expr,
      message: row.message,
      createdAt: row.created_at,
      lastRunAt: row.last_run_at,
      runCount: row.run_count,
      maxRuns: row.max_runs,
      enabled: row.enabled === 1,
    };
  }
}
