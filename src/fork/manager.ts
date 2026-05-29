import { ForkStore, FORK_TIMEOUT_MS } from "./store.js";
import type { ForkJob } from "./store.js";
import type { ActiveAgent } from "../ipc/types.js";
import { deliverToAgent } from "../ipc/router.js";
import type { BridgeSessionStore } from "../session/bridge-session.js";
import { createLogger } from "../util/logger.js";
import { getErrorMessage } from "../util/errors.js";

const log = createLogger("fork");

// ---------------------------------------------------------------------------
// ForkManager — manages agent fork lifecycle
//
// A fork creates a sub-session of the SAME agent (same provider) to execute
// a task independently. The result is reported back to the parent agent's
// main session via queuedSend / deliverToAgent.
// ---------------------------------------------------------------------------

export class ForkManager {
  private agents: ActiveAgent[] = [];
  private bridgeSessionStore?: BridgeSessionStore;
  /** Active fork timers for timeout enforcement. */
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private store: ForkStore) {}

  /** Set live agent list (call after agents start). */
  setAgents(agents: ActiveAgent[], bridgeSessionStore?: BridgeSessionStore): void {
    this.agents = agents;
    this.bridgeSessionStore = bridgeSessionStore;
  }

  /**
   * Fork the agent: create a sub-session with the same provider,
   * deliver the task, wait for result, then report back.
   * Non-blocking — fires in background.
   */
  fork(opts: {
    parentAgent: string;
    task: string;
    model?: string;
    cwd?: string;
  }): ForkJob {
    const job = this.store.add(opts.parentAgent, opts.task, opts.model);

    log.info(`fork[${job.id}] ${opts.parentAgent} → self: "${opts.task.slice(0, 80)}..."`);

    // Execute in background (non-blocking)
    this.executeFork(job, opts.cwd).catch((err) => {
      log.warn(`fork[${job.id}] background error: ${getErrorMessage(err)}`);
    });

    return job;
  }

  /** Cancel a running fork job. */
  cancel(id: string): boolean {
    const timeout = this.timeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }
    const cancelled = this.store.cancel(id);
    if (cancelled) {
      log.info(`fork[${id}] cancelled`);
    }
    return cancelled;
  }

  /** Stop all active forks and close the store. */
  stopAll(): void {
    for (const [id, timeout] of this.timeouts) {
      clearTimeout(timeout);
      this.store.cancel(id);
      log.info(`fork[${id}] stopped on shutdown`);
    }
    this.timeouts.clear();
    this.store.close();
  }

  /** Recover stale running jobs on startup (mark all as failed). */
  recoverStale(): number {
    const running = this.store.listRunning();
    for (const job of running) {
      this.store.complete(job.id, "failed", "Stale — bridge restarted");
      log.info(`fork[${job.id}] marked as failed (stale — bridge restarted)`);
    }
    if (running.length > 0) {
      log.info(`Recovered ${running.length} stale fork job(s)`);
    }
    return running.length;
  }

  /** Number of active fork timeouts. */
  get activeCount(): number {
    return this.timeouts.size;
  }

  /** Public proxy for ForkStore.listByParent(). */
  listByParent(agent: string): ForkJob[] {
    return this.store.listByParent(agent);
  }

  /** Public proxy for ForkStore.listAll(). */
  listAll(): ForkJob[] {
    return this.store.listAll();
  }

  /** Public proxy for ForkStore.get(). */
  getJob(id: string): ForkJob | null {
    return this.store.get(id);
  }

  // -------------------------------------------------------------------------
  // Internal execution
  // -------------------------------------------------------------------------

  private async executeFork(job: ForkJob, cwd?: string): Promise<void> {
    // Fork targets the SAME agent as parent
    const agent = this.agents.find(
      (a) => a.name.toLowerCase() === job.parentAgent.toLowerCase(),
    );

    if (!agent) {
      this.store.complete(job.id, "failed", `Agent "${job.parentAgent}" not found`);
      return;
    }

    // Build context from main session to carry over to fork
    const mainSessionId = `${agent.name}:default`;
    let contextPrefix = "";
    if (this.bridgeSessionStore) {
      const mainContext = this.bridgeSessionStore.buildContext(mainSessionId);
      if (mainContext) {
        contextPrefix = `[Fork context from main session]\n${mainContext}\n\n[Fork task]\n`;
      }
    }

    // Wrap the task in <user-current-message> so addUserMessage's extractor
    // stores just the task in the user_message column. Otherwise the entire
    // wrapped prompt (including the bloated [Fork context] block) ends up in
    // user_message, and the next buildContext call re-injects it — that's the
    // exponential growth that hit gina (2.6 MB / 1.13 M tokens after 5 forks).
    const forkContent = `${contextPrefix}<user-current-message>\n${job.task}\n</user-current-message>`;

    // Set timeout
    const timer = setTimeout(() => {
      this.timeouts.delete(job.id);
      const current = this.store.get(job.id);
      if (current && current.status === "running") {
        this.store.complete(job.id, "failed", "Fork timed out after 30 minutes");
        this.reportToParent(job, "failed", "Fork timed out after 30 minutes");
        log.warn(`fork[${job.id}] timed out`);
      }
    }, FORK_TIMEOUT_MS);
    this.timeouts.set(job.id, timer);

    try {
      // Use deliverToAgent with a fork-specific source tag
      // The sub-session is handled by deliverToAgent's session routing
      const result = await deliverToAgent(agent, forkContent, {
        source: `fork:${job.id}`,
        cwd: cwd ?? agent.agentConfig.cwd,
        model: job.model ?? undefined,
        bridgeSessionStore: this.bridgeSessionStore,
        timeoutMs: FORK_TIMEOUT_MS,
      });

      // Clear timeout
      clearTimeout(timer);
      this.timeouts.delete(job.id);

      // Check if already cancelled/timed out
      const current = this.store.get(job.id);
      if (!current || current.status !== "running") {
        log.info(`fork[${job.id}] completed but status already ${current?.status ?? "unknown"}`);
        return;
      }

      // Mark as completed
      this.store.complete(job.id, "completed", result.text);
      log.info(`fork[${job.id}] completed in ${result.durationMs}ms`);

      // Report result back to parent agent
      this.reportToParent(job, "completed", result.text);
    } catch (err) {
      // Clear timeout
      clearTimeout(timer);
      this.timeouts.delete(job.id);

      const msg = getErrorMessage(err);

      // Check if already cancelled
      const current = this.store.get(job.id);
      if (!current || current.status !== "running") return;

      this.store.complete(job.id, "failed", msg);
      this.reportToParent(job, "failed", msg);
      log.warn(`fork[${job.id}] failed: ${msg}`);
    }
  }

  private reportToParent(job: ForkJob, status: "completed" | "failed", result: string): void {
    const parent = this.agents.find(
      (a) => a.name.toLowerCase() === job.parentAgent.toLowerCase(),
    );

    if (!parent) {
      log.warn(`fork[${job.id}] parent agent "${job.parentAgent}" not found, cannot report`);
      return;
    }

    const statusLabel = status === "completed" ? "完成" : "失敗";
    const preview = result.length > 2000 ? result.slice(0, 2000) + "\n...(truncated)" : result;
    const content = `[fork:${job.id}] ${statusLabel}\n${preview}`;

    deliverToAgent(parent, content, {
      source: `fork:${job.id}`,
      bridgeSessionStore: this.bridgeSessionStore,
    }).catch((err) => {
      log.warn(`fork[${job.id}] report to parent failed: ${getErrorMessage(err)}`);
    });
  }
}
