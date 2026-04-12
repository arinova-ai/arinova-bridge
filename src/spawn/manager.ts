import { SpawnStore, SPAWN_TIMEOUT_MS } from "./store.js";
import type { SpawnJob } from "./store.js";
import type { ActiveAgent } from "../ipc/types.js";
import { deliverToAgent } from "../ipc/router.js";
import type { BridgeSessionStore } from "../session/bridge-session.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("spawn");

// ---------------------------------------------------------------------------
// SpawnManager — manages sub-process lifecycle for session spawn
// ---------------------------------------------------------------------------

export class SpawnManager {
  private agents: ActiveAgent[] = [];
  private bridgeSessionStore?: BridgeSessionStore;
  /** Active spawn timers for timeout enforcement. */
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Active flush timers for log buffering — tracked for clean shutdown. */
  private flushTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Set to true on shutdown to prevent late DB writes. */
  private closed = false;

  constructor(private store: SpawnStore) {}

  /** Set live agent list (call after agents start). */
  setAgents(agents: ActiveAgent[], bridgeSessionStore?: BridgeSessionStore): void {
    this.agents = agents;
    this.bridgeSessionStore = bridgeSessionStore;
  }

  /**
   * Spawn a sub-session: deliver context to target agent, wait for result,
   * then report back to parent agent. Non-blocking — fires in background.
   */
  spawn(opts: {
    parentAgent: string;
    targetAgent: string;
    context: string;
    model?: string;
    cwd?: string;
  }): SpawnJob {
    const job = this.store.add(opts.parentAgent, opts.targetAgent, opts.context, opts.model);

    log.info(`spawn[${job.id}] ${opts.parentAgent} → ${opts.targetAgent}: "${opts.context.slice(0, 80)}..."`);

    // Execute in background (non-blocking)
    this.executeSpawn(job, opts.cwd).catch((err) => {
      log.warn(`spawn[${job.id}] background error: ${err instanceof Error ? err.message : String(err)}`);
    });

    return job;
  }

  /** Cancel a running spawn job. */
  cancel(id: string): boolean {
    const timeout = this.timeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }
    const cancelled = this.store.cancel(id);
    if (cancelled) {
      log.info(`spawn[${id}] cancelled`);
    }
    return cancelled;
  }

  /** Stop all active spawns and close the store. */
  stopAll(): void {
    this.closed = true;
    for (const [id, timeout] of this.timeouts) {
      clearTimeout(timeout);
      this.store.cancel(id);
      log.info(`spawn[${id}] stopped on shutdown`);
    }
    this.timeouts.clear();
    for (const [, timer] of this.flushTimers) {
      clearInterval(timer);
    }
    this.flushTimers.clear();
    this.store.close();
  }

  /** Recover stale running jobs on startup (mark all as failed).
   *  After a bridge restart, no in-memory promises exist to complete them. */
  recoverStale(): number {
    const running = this.store.listRunning();
    for (const job of running) {
      this.store.complete(job.id, "failed", "Stale — bridge restarted");
      log.info(`spawn[${job.id}] marked as failed (stale — bridge restarted)`);
    }
    if (running.length > 0) {
      log.info(`Recovered ${running.length} stale spawn job(s)`);
    }
    return running.length;
  }

  /** Number of active spawn timeouts. */
  get activeCount(): number {
    return this.timeouts.size;
  }

  /** Public proxy for SpawnStore.listByParent(). */
  listByParent(agent: string): SpawnJob[] {
    return this.store.listByParent(agent);
  }

  /** Public proxy for SpawnStore.listAll(). */
  listAll(): SpawnJob[] {
    return this.store.listAll();
  }

  /** Public proxy for SpawnStore.get(). */
  getJob(id: string): SpawnJob | null {
    return this.store.get(id);
  }

  /** Get intermediate logs for a spawn job. */
  getLogs(id: string): Array<{ content: string; createdAt: number }> {
    return this.store.getLogs(id);
  }

  /** Clean up logs older than 7 days. Returns number of deleted entries. */
  cleanupOldLogs(): number {
    return this.store.cleanupOldLogs();
  }

  // -------------------------------------------------------------------------
  // Internal execution
  // -------------------------------------------------------------------------

  private async executeSpawn(job: SpawnJob, cwd?: string): Promise<void> {
    const target = this.agents.find(
      (a) => a.name.toLowerCase() === job.targetAgent.toLowerCase(),
    );

    if (!target) {
      this.store.complete(job.id, "failed", `Target agent "${job.targetAgent}" not found`);
      this.reportToParent(job, "failed", `Target agent "${job.targetAgent}" not found`);
      return;
    }

    // Set timeout
    const timer = setTimeout(() => {
      this.timeouts.delete(job.id);
      const current = this.store.get(job.id);
      if (current && current.status === "running") {
        this.store.complete(job.id, "failed", "Spawn timed out after 30 minutes");
        this.reportToParent(job, "failed", "Spawn timed out after 30 minutes");
        log.warn(`spawn[${job.id}] timed out`);
      }
    }, SPAWN_TIMEOUT_MS);
    this.timeouts.set(job.id, timer);

    // Log buffer — flush accumulated chunks every 2 seconds to reduce DB writes
    let logBuffer = "";

    const flushLog = () => {
      if (this.closed || !logBuffer) return;
      try {
        this.store.appendLog(job.id, logBuffer);
        logBuffer = "";
      } catch { /* DB may be closed during shutdown */ }
    };

    const flushTimer = setInterval(flushLog, 2000);
    this.flushTimers.set(job.id, flushTimer);

    try {
      // Deliver context to target agent and wait for result
      const result = await deliverToAgent(target, job.context, {
        source: `spawn:${job.id}`,
        cwd: cwd ?? target.agentConfig.cwd,
        model: job.model ?? undefined,
        bridgeSessionStore: this.bridgeSessionStore,
        timeoutMs: SPAWN_TIMEOUT_MS,
        onLog: (text) => { logBuffer += text; },
      });

      // Clear timers and flush remaining log
      clearTimeout(timer);
      clearInterval(flushTimer);
      this.flushTimers.delete(job.id);
      flushLog();
      this.timeouts.delete(job.id);

      // Check if already cancelled/timed out
      const current = this.store.get(job.id);
      if (!current || current.status !== "running") {
        log.info(`spawn[${job.id}] completed but status already ${current?.status ?? "unknown"}`);
        return;
      }

      // Mark as completed
      this.store.complete(job.id, "completed", result.text);

      log.info(`spawn[${job.id}] completed in ${result.durationMs}ms`);

      // Report result back to parent agent
      this.reportToParent(job, "completed", result.text);
    } catch (err) {
      // Clear timers and flush remaining log
      clearTimeout(timer);
      clearInterval(flushTimer);
      this.flushTimers.delete(job.id);
      flushLog();
      this.timeouts.delete(job.id);

      const msg = err instanceof Error ? err.message : String(err);

      // Check if already cancelled
      const current = this.store.get(job.id);
      if (!current || current.status !== "running") return;

      this.store.complete(job.id, "failed", msg);
      this.reportToParent(job, "failed", msg);
      log.warn(`spawn[${job.id}] failed: ${msg}`);
    }
  }

  private reportToParent(job: SpawnJob, status: "completed" | "failed", result: string): void {
    const parent = this.agents.find(
      (a) => a.name.toLowerCase() === job.parentAgent.toLowerCase(),
    );

    if (!parent) {
      log.warn(`spawn[${job.id}] parent agent "${job.parentAgent}" not found, cannot report`);
      return;
    }

    const statusLabel = status === "completed" ? "完成" : "失敗";
    const preview = result.length > 2000 ? result.slice(0, 2000) + "\n...(truncated)" : result;
    const content = `[spawn:${job.id} from:${job.targetAgent}] ${statusLabel}\n${preview}`;

    deliverToAgent(parent, content, {
      source: `spawn:${job.id}`,
      bridgeSessionStore: this.bridgeSessionStore,
    }).catch((err) => {
      log.warn(`spawn[${job.id}] report to parent failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
