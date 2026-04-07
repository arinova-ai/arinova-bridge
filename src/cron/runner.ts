import cron from "node-cron";
import type { CronJob, CronStore } from "./store.js";
import type { ActiveAgent } from "../ipc/types.js";
import { deliverToAgent } from "../ipc/router.js";
import type { BridgeSessionStore } from "../session/bridge-session.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("cron");

// ---------------------------------------------------------------------------
// CronRunner — schedules node-cron tasks, delivers via IPC on tick
// ---------------------------------------------------------------------------

export class CronRunner {
  private tasks = new Map<string, cron.ScheduledTask>();
  private agents: ActiveAgent[] = [];
  private bridgeSessionStore?: BridgeSessionStore;

  constructor(
    private store: CronStore,
  ) {}

  /** Set the live agent list (call after all agents have started). */
  setAgents(agents: ActiveAgent[], bridgeSessionStore?: BridgeSessionStore): void {
    this.agents = agents;
    this.bridgeSessionStore = bridgeSessionStore;
  }

  /**
   * Load all enabled jobs from the store and schedule them.
   * Call once at bridge startup after agents are ready.
   */
  restoreAll(): number {
    const jobs = this.store.listEnabled();
    let scheduled = 0;
    for (const job of jobs) {
      if (this.schedule(job)) scheduled++;
    }
    if (scheduled > 0) {
      log.info(`Restored ${scheduled} cron job(s)`);
    }
    return scheduled;
  }

  /**
   * Schedule a single cron job. Returns true if scheduled successfully.
   */
  schedule(job: CronJob): boolean {
    // Validate cron expression
    if (!cron.validate(job.cronExpr)) {
      log.warn(`cron[${job.id}] invalid expression "${job.cronExpr}", skipping`);
      return false;
    }

    // Stop existing task if re-scheduling
    this.unschedule(job.id);

    const task = cron.schedule(job.cronExpr, () => {
      this.onTick(job).catch((err) => {
        log.warn(`cron[${job.id}] tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    this.tasks.set(job.id, task);
    log.info(`cron[${job.id}] scheduled: "${job.cronExpr}" → agent=${job.agentName} msg="${job.message.slice(0, 60)}"`);
    return true;
  }

  /** Unschedule a single job by ID. */
  unschedule(id: string): void {
    const existing = this.tasks.get(id);
    if (existing) {
      existing.stop();
      this.tasks.delete(id);
    }
  }

  /** Stop all scheduled tasks and close the store. */
  stopAll(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
      log.info(`cron[${id}] stopped`);
    }
    this.tasks.clear();
    this.store.close();
  }

  /** Number of currently scheduled tasks. */
  get size(): number {
    return this.tasks.size;
  }

  // -------------------------------------------------------------------------
  // Tick handler
  // -------------------------------------------------------------------------

  private async onTick(job: CronJob): Promise<void> {
    const target = this.agents.find(
      (a) => a.name.toLowerCase() === job.agentName.toLowerCase(),
    );

    if (!target) {
      log.warn(`cron[${job.id}] agent "${job.agentName}" not found, skipping tick`);
      return;
    }

    const content = `[cron:${job.id}] ${job.message}`;
    log.info(`cron[${job.id}] firing → ${job.agentName}: ${job.message.slice(0, 80)}`);

    try {
      await deliverToAgent(target, content, {
        source: `cron:${job.id}`,
        bridgeSessionStore: this.bridgeSessionStore,
      });
      // Only record on successful delivery
      this.store.recordRun(job.id);
    } catch (err) {
      log.warn(`cron[${job.id}] deliver failed: ${err instanceof Error ? err.message : String(err)}`);
      return; // Don't count failed deliveries
    }

    // Re-check if auto-disabled (max_runs reached)
    const updated = this.store.get(job.id);
    if (updated && !updated.enabled) {
      this.unschedule(job.id);
      log.info(`cron[${job.id}] auto-disabled after ${updated.runCount} runs`);
    }
  }
}
